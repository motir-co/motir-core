# Roadmap — design notes

Design reference for the **`roadmap`** UI area — the **reusable, deterministic
work-item canvas** (Subtask **MOTIR-1009 / 7.3.76**). One canvas component that
renders any project's **work-item tree + pre-plan phase** in a fixed, opinionated
layout. It is the auto-arranged **sibling** of the free-form **spatial canvas**
(`design/ai-chat/canvas-spatial.*`, `MOTIR-1235`): the **same node + edge
model**, a **different layout discipline** — where the spatial canvas lets the
user drag nodes anywhere, this one auto-initialises them in a deterministic
arrangement (still pannable / zoomable; nodes still draggable from there).

> **This is the FOUNDATION design.** Its BUILD is the standalone component
> `MOTIR-1194 / 7.3.77` (which this card `blocks`). It is consumed by:
> start-fresh onboarding (**7.3** / `MOTIR-804`), migrate-existing onboarding
> (**7.15** / `MOTIR-815`), re-planning (**7.11** / `MOTIR-811`), the persistent
> roadmap (**7.19** / `MOTIR-1011`, which this card `blocks`), and the public
> project page (unplanned). Design it surface-agnostic.

## Asset set (the files)

| File                                      | What it is                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design-notes.md`                         | this spec (primitives, copy, token roles, per-behaviour provenance)                                                                                     |
| `roadmap.mock.html`                       | the canvas source of truth — a multi-panel mock built from the real tokens                                                                              |
| `roadmap.png`                             | the full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                                                                        |
| `edges.mock.html`                         | the dependency-edge spec (7.20.8 / MOTIR-1331) — arrows + legend + cross-story                                                                          |
| `edges.png`                               | its full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                                                                        |
| `grid-init.mock.html`                     | grid + init arrangement (7.20.9 / MOTIR-1333) — grid system + the plan preview                                                                          |
| `grid-init.png`                           | its full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                                                                        |
| `detail-surfaces.mock.html`               | the canvas **detail surfaces** (MOTIR-1351): work-item quick-view + tier-doc viewer + their on-canvas entries                                           |
| `detail-surfaces.png`                     | the detail-surfaces export (same render settings)                                                                                                       |
| `auto-drill.mock.html`                    | the **auto-descended ARRIVAL state** (MOTIR-1805): the breadcrumb on first paint + the negative cases                                                   |
| `auto-drill.png`                          | its full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                                                                        |
| `planning-origin-drill.mock.html`         | the **planning card DRILLS into the pre-plan stations** (MOTIR-2204): the phase card, the drilled station level, and the card's honest states           |
| `planning-origin-drill.png` / `.dark.png` | its full-page exports (light + dark — the station tiles' tier tints are checked in both)                                                                |
| `root-non-epic-rows.mock.html`            | the ROOT level's **non-epic rows** (MOTIR-3493): the grouped node, the level it drills into, and a level cap that is visible                            |
| `root-non-epic-rows.png`                  | its full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                                                                        |
| `roadmap-arrival.mock.html`               | the **roadmap you come back to** (MOTIR-3834): the level-addressable URL, the full-fold frame, the collapsible Dependencies panel, and the ARRIVAL view |
| `roadmap-arrival.png`                     | its full-page export (`scripts/render-design-mock.mjs`, light, `deviceScaleFactor 2`, 1200px)                                                           |
| `roadmap--folder-node.mock.html`          | a **FOLDER on the canvas** (MOTIR-5713): the folder card, the folder level, and the navigable folder crumb — a delta                                    |
| `edges--covered-by-parent.mock.html`      | **covered cross-parent edges** (MOTIR-6353): when _blocked elsewhere_ shows, the covered and exempt cases, the legend copy — a delta                    |

The `roadmap` mock is a **multi-panel review board** — six sheets (5 spec + the
multi-level drill-down sheet, below), every panel inspected (the multi-panel
rule, `notes.html` #31). The `detail-surfaces` mock is the
**[Canvas detail surfaces](#-canvas-detail-surfaces-the-quick-view--tier-doc-viewer-motir-1351)**
the canvas OPENS — documented in its own section below.

---

## ⭐ Built on SHIPPED REALITY (rung 2 — design-against-shipped-reality)

This canvas does **not** invent an engine. It **renders on the shipped
`PlanningCanvas`** (`MOTIR-1236`, done — `components/planning/PlanningCanvas.tsx`):
a Miro-style **pan / zoom / drag / fit viewport** that draws caller-supplied
**nodes + READ-ONLY dependency edges**. This design supplies the **deterministic
LAYOUT + node / edge CONTENT**, not a new canvas. The node cards reuse the
shipped **`StationCard`** language (`components/onboarding/StationNode.tsx`): the
tier-coloured tile, title + subtitle, the state pill, and the captured-findings
rows. So the mock mirrors the running UI rather than a stylised stand-in.

**The build split it slots into** (so the FOUNDATION reuse is real):

- `PlanningCanvas` (`MOTIR-1236`) — the surface + interaction (pan/zoom/drag/fit,
  read-only edges, `onNodeMove` / `onNodeActivate`). **Reused, never rebuilt.**
- `MOTIR-1194 / 7.3.77` — the **standalone work-item canvas component** this
  design specifies: the deterministic auto-layout + the node/edge content +
  search-to-focus + filters, composed over `PlanningCanvas`.
- The onboarding consumer `OnboardingCanvas` (`MOTIR-840`) is the existing,
  shipped composition the deterministic layout generalises.

### Edge convention — match the engine, add the cross-story case

The shipped `PlanningCanvas` draws edges in **two neutral variants**:
`firm` = solid `--el-border-strong`; `pending` = dashed `--el-border`. This
design **adopts that convention verbatim** (the spatial _mock_'s illustrative
green/accent edges were a simplification; the engine — the reality — is neutral).
It **adds one variant**: a **cross-story `blocked_by`** edge, drawn **warning-
toned** (`--el-warning`) **+ a flag badge** at its midpoint, so the dependency
tangle the arrow-audit forbids is visible (carried from `MOTIR-1009`). This is a
clean superset; `7.3.77`'s build adds a `variant: 'cross'` to `CanvasEdge`.

---

## ⭐ Dependency-edge LEGIBILITY (Subtask 7.20.8 / MOTIR-1331 — `edges.mock.html`)

The shipped per-level canvas (`MOTIR-1194`) drew the firm / pending / cross edges
but three things were illegible or unhandled. This section specifies them; the
build adds them to `PlanningCanvas`'s edge `<svg>` (still read-only, non-scaling
stroke). Drawn on **`edges.mock.html` sheets 1 (in-level) + 2 (cross-level)**.

### 1. DIRECTION — an arrowhead, one stated convention

Edges were undirected lines — you could not tell which item blocked which. Every
edge now carries an **arrowhead at its `to` end**, and the convention is fixed and
stated **everywhere**:

> **The arrow points from the BLOCKER to the item it blocks** — `A → B` reads
> "A blocks B / B can't start until A is done" (the unblocking flow). This matches
> the engine's `CanvasEdge.from = blocker`, `to = blocked`.

The arrowhead is an SVG `<marker>` (a filled triangle, `markerWidth ≈ 7`,
`orient="auto"`) **coloured to match its edge** — one marker per variant (firm =
`--el-border-strong`, pending = `--el-border`, cross = `--el-danger`) so the head
reads at a glance. It rides the shipped cubic-bezier connector; `vector-effect:
non-scaling-stroke` keeps it crisp at any zoom.

### 2. A LEGEND on the canvas (what the styles MEAN)

The canvas never told the reader what solid vs dashed meant. Add a small,
unobtrusive **edge legend** — a fixed overlay anchored **bottom-left** (the zoom
control already owns bottom-left in the engine; the legend sits beside it, or
bottom-left with zoom moved to bottom-right on this surface), `--el-surface` card,
`--radius-card`, `--shadow-card`. It lists each edge style with a **directional
swatch** + a plain-language meaning:

- **solid arrow → "blocks"** — _blocker is done (the dependency is settled / ready)_
- **dashed arrow ⟶ "pending"** — _blocker is not done yet_
- **red arrow → "blocked elsewhere"** — _blocker sits elsewhere in the plan (a bad plan)_

(Header "Dependencies", `--el-text-secondary` uppercase caption; rows
`--el-text-strong`, the meanings `--el-text-muted`.) It is the SAME three styles
the edges use, so the canvas is self-documenting.

### 3. CROSS-LEVEL / cross-story SIGNAL — the off-level blocker (the heart, sheet 2)

A badly-planned project can set a work item `blocked_by` an item on **another
level** (a different story / epic). The per-level read (`MOTIR-1010`) already
RETURNS that edge (its blocker id is off-level), but the canvas has no on-screen
node for the blocker — so it was dropped. It must instead read as the **bad-plan
TANGLE** the dependency-arrow audit forbids (a correct plan is a tree). Design:

- **A RED edge** (`--el-danger`, slightly heavier, solid) with the red arrowhead —
  visually distinct from the neutral in-level firm/pending.
- **A GHOST ANCHOR** for the off-level blocker (it has no node here): a small
  **dashed-red, hatched chip** that NAMES the blocker — its identifier (`PROD-42`,
  with an **↗ "leaves this level"** glyph), its title, and **where it lives**
  ("in Story · Auth hardening ↗", `--el-danger` text). The red edge runs from this
  anchor INTO the blocked node, so the tangle is legible without leaving the level.
- **A node BADGE** on the blocked item — a `blocked elsewhere` flag pill
  (`--el-danger-surface` tint + strong text + a flag glyph) + a red node ring — so
  even off-screen of the edge, the node reads as entangled (not colour-alone:
  icon + label + tint, AA).

> **Label copy — "blocked elsewhere", not "cross-story" (MOTIR-1568).** The pill,
> the edge-midpoint flag, and the legend's warning row all read **"blocked
> elsewhere"** (project scope). The bad-plan signal here is still conceptually the
> _cross-story / off-level tangle_, but the user-facing COPY is deliberately
> level-agnostic: the blocked item's blocker can live in another story, another
> epic, or under a bug/task, and one pill cannot name a mix — so it states the fact
> ("blocked by something elsewhere in the plan") and the ghost anchor names the
> specific blocker. Plain-English state phrase, matching its sprint-scope sibling
> "not in sprint".

- **States:** one vs several off-level blockers (the anchor stacks "+N more");
  **hover/tooltip** on the flag names the blocker + its level; **click** → drill to
  the blocker's level (the canvas already navigates per level). The normal
  (in-level, tree-shaped) case is unaffected — no anchor, no red.

**Build note.** The consumer's `loadLevel` already gets each level's edges; for an
edge whose blocker is NOT in the level's node set, emit a `cross` dep + a ghost
anchor node (id = the blocker, rendered as the anchor chip) so `PlanningCanvas`
draws the red edge to a real anchored target, and flag the blocked node. The
within-level firm/pending arrows are unchanged.

---

## ⭐ GRID system + INIT arrangement (Subtask 7.20.9 / MOTIR-1333 — `grid-init.mock.html`)

This **refines** the deterministic initial layout (below) into a real GRID, and
fixes what the init screen shows for a project that ALREADY has a planned tree.
Drawn on **`grid-init.mock.html` sheet 1 (the init screen) + 2 (the preview up
close)**.

### 1. A grid SYSTEM (not an ad-hoc serpentine)

Every node **initialises snapped to a fixed grid cell** — a reproducible,
tidy arrangement (the mock uses a **268 × 160** cell; the build keys it off the
node card width + a gutter). The grid is the INIT discipline only: the user can
still **drag freely**, and a saved position (the 7.3.77 persistence) overrides the
grid per node. The dot-grid the engine already paints stays; the cell guides are a
faint `#0000000a` overlay so the grid reads without shouting. The stations lay out
on the grid (idea → the four tiers → design → plan), `you-are-here` ringed,
upcoming dimmed — the serpentine below, but cell-snapped.

### 2. Init shows the WHOLE project on ONE screen — stations + the plan

At init (no saved layout) the canvas `fit`s so BOTH halves are visible at once:
the **pre-plan stations** (the journey) AND the **existing work items**. For a
project with no tree yet (fresh onboarding) the plan slot is just the `Plan` node;
once a tree exists, that node carries a **preview** (below). One screen, one
glance — "here's the journey, and here's the plan it produced."

### 3. The work items are fit PARTIALLY — a PREVIEW that says "there's a plan here" (Yue)

The init screen must NOT cram the whole tree on. The produced epics render as a
compact **plan-preview cluster** hung off the `Plan` station — a `--el-surface`
card (`--radius-card`, `--shadow-card`) with:

- a **header** — an epic-hued tile + **"Your plan"** + a summary line
  `10 epics · 142 work items · 58 done`, and an **"Explore the plan →"** primary
  button (`--el-accent`);
- a thin **progress bar** (done / total, `--el-success` fill over `--el-muted`);
- a **row of compact epic mini-cards** (the first ~4: an epic dot in `--el-type-epic`,
  the identifier mono-faint, the title 2-line-clamped, a tiny count "58 / 58 done"
  / "in progress"), capped by a dashed **"+ N more epics"** tile.

It reads as **"the plan exists and is explorable"**, not the full graph. **Clicking
an epic mini-card — or "Explore the plan" — DRILLS into the full per-level roadmap**
(epic → story → subtask, MOTIR-1194); the preview only ever reads the **epic roots**
(the per-level read, MOTIR-1010), so a 1000-item plan still inits instantly.

### Build note

The onboarding consumer already feeds `loadLevel(null)` = stations + the root
epics. For the init preview, the root level renders the stations + a SINGLE
`plan-preview` node (not the epics fanned out) that the consumer composes from the
roots read (count + the first N + the done/total rollup if available, else just
the count); its "Explore"/epic-click sets the canvas focus to drill. Snapping is a
pure grid function in the deterministic layout (`col·cellW, row·cellH`).

---

## The deterministic INITIAL LAYOUT (the heart of the card — Yue, 2026-06-22)

Nodes auto-initialise in this fixed arrangement (it **refines** the space-filling
serpentine the spatial canvas uses — here the layout is **opinionated, not
space-filling**). Drawn on **sheet 1** (start-fresh) + **sheet 2** (migrate):

- **Row 1 — the 4 pre-plan tiers, left → right in ONE row:** _Understanding your
  idea_ · _What we'll build_ · _Is it worth building?_ · _Will people want it?_
  (plain language, never jargon — the canvas-spatial copy rule). The seed **Your
  idea** node sits at the left, feeding the row (omitted on a resume with no idea).
- **Row 2 — _Design your look_**, and — **only when the project already has work
  items — _Read your project_** in the same row.
- **Then a single _Plan → your project_ node — NOT the epics fanned out.** The
  plan node stands for the produced backlog; epics / stories appear on
  expand / post-plan (sheet 3), never in the initial layout.

**Skippable steps get DOTTED borders** — the two optional tiers, the design step,
and _Read your project_. **Distinct from** the _upcoming / ghosted_ **DASHED**
border the shipped canvas already uses: **skippable = dotted, upcoming = dashed**
(spelled out in the sheet-1 legend + the sheet-4 state strip). Skip semantics
come from the gated step machine (`MOTIR-838`) + conductor (`MOTIR-1099`) — a skip
is a **chat** decision before a tier drafts, never a button on the node (the
canvas-spatial gate-rhythm rule).

---

## The screens (sheets, in the mock)

| Sheet | Screen                           | What it shows                                                                                                                                                          |
| ----- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Initial layout — **start-fresh** | the deterministic arrangement; node states; dotted-vs-dashed; the **Board ↔ Roadmap** view toggle (the access path); zoom + legend                                     |
| **2** | Initial layout — **migrate**     | the same layout + **Read your project** (the 7.15 entry: connect repo + grant Motir AI access); the search-to-focus field                                              |
| **3** | **Post-plan** tree               | plan → epic → story → subtask; within-story dep arrow **vs.** the cross-story `blocked_by` warning edge + flag; migrate linking (linked-under-tier **and** standalone) |
| **4** | **Node states** spec strip       | done / active-frontier / deciding / skippable(dotted) / upcoming(dashed) / drafting — each an icon + label + tint                                                      |
| **5** | **Controls & states**            | filters (status / assignee / epic) · search-to-focus · density · empty / loading / error · the reuse note                                                              |
| **6** | Multi-level — **drill-down**     | the chain at every level: click a node → the canvas refreshes to that node's children as a chain; breadcrumb + Back (3 states drawn)                                   |

---

## ⚠️ MULTI-LEVEL CHAINS — DRILL-DOWN (decided, Yue 2026-06-22; sheet 6)

The planner orders same-level work as a **chain (DAG) at EVERY level** — epic↔epic, story↔story,
subtask↔subtask (`plan.md`'s dependency-arrow rule: "genuinely sequential work → a chain"). So the
roadmap renders the **story-level and subtask-level chains**, not only the epic level. (Sheet 3's
rows-inside-an-epic-card stay as a compact SUMMARY of an epic's contents; the navigable lower-level
**roadmaps** are this drill-down.)

**The model is DRILL-DOWN (self-similar).** Click a node and the canvas **REFRESHES to that node's
children**, laid out as their own chain; a breadcrumb (`Plan ▸ Invoices ▸ Create invoice`) + a
**Back** control walks you up. One level fills the screen at a time, so each chain stays big + legible
**at any tree size** — the completeness / scale axis. Zoom-to-fit still gives a whole-level overview.
Sheet 6 draws the three drill states (epic chain → story chain → subtask chain).

**Why drill-down** (the chosen model over expand-in-place and a level toggle): it is the only one that
stays legible on a real, large plan; it reuses the shipped `PlanningCanvas` engine cleanly (the **same
surface**, re-fed the per-level nodes + edges on drill — no new engine); and it EXTENDS, rather than
overturns, the already-decided spatial-canvas **"self-similar at every level"** direction. A
power-user expand-in-place could be added later as an affordance, but drill-down is the core model.

> Drill-down reuses the SAME node + edge language as sheets 1-5 (the shipped `StationCard` /
> `PlanningCanvas` languages, `--el-type-*` hues, neutral firm / dashed-pending edges + the cross-story
> warning edge) — only the per-level node + edge SET changes on drill. Build (`MOTIR-1194`): the
> consumer re-feeds the engine the children of the focused node + their same-level `blocked_by` edges,
> and tracks the breadcrumb path; the engine is unchanged.

---

## ⚠️ "Read your project" IS the migrate-onboarding entry (sheet 2)

Existing work items imply an **existing project** — and a **git repo** — so this
node leads into **migrate-existing-codebase onboarding** (`MOTIR-815` / wizard
`MOTIR-930`). The node DRAWS the entry the migrate flow specifies (read TO the
spec, `MOTIR-930` `descriptionMd` — never invent it): **connect the git repo** +
**grant Motir AI read access**, with a **Connect GitHub** button (the `7.7`
connect surface, composed). The AI then **reads the project** (existing items +
code) and folds it into the tiers — the node's captured row shows
`Read 1,240 files · 86 work items`. This card draws the **node + the post-plan
linking**; the BUILD is the 7.15 flow (`MOTIR-815` / `MOTIR-930`), not a separate
7.3 subtask. Shown **only when** the project already has work items.

**Post-plan linking (sheet 3).** Once planning produces the backlog, an existing
work item is **LINKED into the tier tree** (attached under the tier / story it
informs — the violet **"Existing: User model · LINKED"** row under Epic 1), **or
left STANDALONE** when it is not reusable (the **"Legacy export job"** cluster,
off on its own with a `STANDALONE` chip). Part of the 7.15 migrate flow.

---

## Carried-over behaviours (still required) — and where each is drawn

| Behaviour                                       | Drawn on     | Source subtask it came from                                                                    |
| ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Dependency **EDGES** (not just tree)            | sheet 3      | `MOTIR-1009`; engine variants from `PlanningCanvas` (`MOTIR-1236`)                             |
| **Cross-story** warning edge + flag             | sheet 3      | `MOTIR-1009` (the dependency-arrow audit — a tangle MEANS the plan is wrong)                   |
| **Search-to-locate-and-focus**                  | sheets 2,5   | `MOTIR-1009` (centre + highlight the match); `/` shortcut                                      |
| **Zoom in/out + fit / overview**                | all canvases | `PlanningCanvas` (`MOTIR-1236`) — `−` / `+` / `⤢` + the % readout (bottom-left)                |
| **Filters** (status / assignee / epic)          | sheet 5      | `MOTIR-1009`                                                                                   |
| **Empty / loading / error**                     | sheet 5      | `MOTIR-1009`; loading paints nodes only after positions resolve (no layout jump, `MOTIR-1253`) |
| **Large-tree** handling / density               | sheet 5      | reuse `PlanningCanvas` pan/zoom + windowing (`MOTIR-1236`) — engine not rebuilt                |
| **Board ↔ Roadmap** view toggle                 | sheet 1      | `MOTIR-1009`; the 7.19 access path (`MOTIR-1011`)                                              |
| **Node states** (done/active/deciding/upcoming) | sheet 4      | `MOTIR-1235` canvas-spatial; finding #35 (icon + label + tint)                                 |
| **Skippable (dotted) vs upcoming (dashed)**     | sheets 1,4   | `MOTIR-1009`; skip machine `MOTIR-838`, conductor `MOTIR-1099`                                 |
| **Captured-findings rows** on produced tiers    | sheets 1,2   | `MOTIR-1235` (StationCard); the conductor's per-tier output (`MOTIR-1099`)                     |
| Validation **deciding / blocking ask**          | sheet 4      | validate-demand-first `MOTIR-1064` (the one blocking ask)                                      |

---

## Primitives composed (no hand-rolling)

| Element                      | Built from                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| the canvas surface           | the shipped **`PlanningCanvas`** (`MOTIR-1236`) — viewport, dot-grid, `world` transform, read-only `<svg>` edges |
| node card                    | the shipped **`StationCard`** language — `Card` + tile + title/sub + state `Pill` + captured rows                |
| state pill                   | **`Pill`** tones — `reviewed` (mint), `here` (lavender), `deciding` (peach), `drafting` (lavender)               |
| "You are here" tab           | accent `Pill` + `map-pin`; node carries `aria-current="step"`                                                    |
| epic / story / subtask tree  | `Card` + the `--el-type-*` work-type hues + the connector language (sheet 3)                                     |
| view toggle / zoom / filters | `Button` group (segmented) · the canvas zoom control (`PlanningCanvas`) · `Pill`-style filter chips              |
| search field                 | `Input` (compact) + `search` glyph + a `/` `<kbd>`                                                               |
| empty / loading / error      | `Card` tints + `Button`; the spinner is `Spinner`                                                                |
| icons                        | lucide-react + the GitHub mark                                                                                   |

---

## Token / a11y discipline

- **Colour** strictly via **`--el-*`**; the mock inlines the real light-palette
  `--el-*` values (exactly as `canvas-spatial.mock.html` does). The **work-item
  type hues** are `--el-type-{epic,story,task,bug,subtask}`
  (`#ff64c8` / `#1aae39` / `#0075de` / `#e03131` / `#2a9d99`); type chips put the
  hue in a **tint background** with strong text (finding #35, AA). No Tier-0
  `--color-*` reached for content.
- **Shape** strictly via element-semantic tokens — node = `--radius-card`,
  chips/pills = `--radius-badge`, controls = `--radius-control`,
  shadow = `--shadow-{subtle,card}` — so a `[data-style]` swap re-shapes the
  canvas. `rounded-full` only on dots / the spinner.
- **Not colour alone** — every state pairs an **icon + label + tint**
  (`Reviewed ✓` · `You are here` map-pin · `Deciding` ⚠ · `Drafting now…`
  sparkles); the **skippable** affordance pairs the **dotted** border with a
  **"can skip"** chip, and **upcoming** the **dashed** border — so the dotted /
  dashed distinction never rests on line-style alone.
- **AA holds** — tint-background + strong-text chips by construction; the
  warning edge's flag badge uses peach tint + `#8a3d00` text.

> **⚠️ AMENDED 2026-09-03 (MOTIR-4350) — the two bullets above were both FALSE for
> `roadmap.mock.html`, `grid-init.mock.html` and `edges.mock.html`, and one of them
> names the invented hue that proves it.**
>
> "Colour strictly via `--el-*`" was true of the VALUES and false of the NAMES. Each of
> these three assets opened with a `:root` block that copied the design system's values
> onto PRIVATE aliases — `--text`, `--strong`, `--muted`, `--faint`, `--surface`,
> `--soft`, `--hub`, `--mutedfill`, `--border`, `--hair`, `--t-epic` … — and painted
> through them at all 259 sites. `tests/theme/inkContrastMockScan.ts` and
> `tests/theme/mockStateInkScan.ts` classify ink by reading an `--el-*` name off the
> declaration AT THE PAINT SITE, so all three sat outside every ink guard in the tree by
> construction, and the guards' tree-wide greens said nothing about them.
>
> **Declaring the ink under its real name made it measurable, and the three assets were
> carrying 55 sub-AA elements** — 22 on `--el-text-faint`, which clears AA on **no**
> surface (2.37–2.61:1), and 33 on `--el-text-muted` at 4.12–4.34:1 on `--el-surface` /
> `--el-surface-soft`. All 55 now take **`--el-text-secondary`** (6.18–6.80:1 on all four
> surfaces, both themes). The rules re-inked:
>
> - `roadmap` — `.sheethead .cap` · `.search kbd` · `.chip .car` · `.crumbs .sep` ·
>   `.reuse` · `.statecard p` · `.estate p`
> - `grid-init` — `.sheethead .cap` · `.em .eid` · `.em .ec` · `.zoomlvl`
> - `edges` — `.sheethead .cap` · `.node .id` · `.pill.todo` · `.legend .lh`
> - Everything the scanner did NOT report keeps the ink it had: `--el-text-faint` on a
>   decorative glyph and `--el-text-muted` on the white page both clear the rule.
>
> **So "AA holds … by construction" is retired.** It held for the chips it was written
> about and was never measured anywhere else, because nothing could measure it. Both arms
> now report **0 findings** over these three assets, which is a check rather than a claim.
>
> **The `#8a3d00` in that bullet has no token twin and is gone** — every ink the sweep
> kept is now `color-mix(in srgb, var(--el-<hue>) N%, var(--el-text))`, inputs all tokens.
>
> **⚠️ AND THE FIVE WORK-TYPE HUES ARE EXACT `--el-type-*` TWINS — the bullet above already
> named the tokens and the assets still hard-coded them.** Read off
> `packages/design-system/theme.css` § _Issue-type hues_: `--el-type-epic` is
> `var(--color-accent)` = `#ff64c8`, `--el-type-story` = `#1aae39`,
> `--el-type-task` = `#0075de`, `--el-type-bug` = `#e03131`, `--el-type-subtask` =
> `#2a9d99`. Not one of them needed a `color-mix()` or a judgement call.
>
> **Three hues genuinely have no twin, and each is named rather than dropped:**
>
> | was                                                                          | is                                                | why                                                                                                                                                                                                |
> | ---------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `--borderstrong: #d3cfc8`                                                    | `--el-border-strong` (`#c8c4be`)                  | role exact; the value was an invented intermediate                                                                                                                                                 |
> | `#9b1c4b` on `edges`' `.crossbadge` / `.ghost .gid`                          | `--el-danger-surface-text` (`#37352f`)            | the design system's own ink FOR `--el-danger-surface` — and § _CROSS-LEVEL signal_ below already specified "strong text" on that tint, so the asset had been diverging from its own note           |
> | `grid-init`'s three pre-plan tier glyphs — `#b58a00` · `#6a5acd` · `#d6336c` | `--el-warning` · `--el-accent` · `--el-highlight` | no token, and no `color-mix()` over tokens, reproduces gold / slate-blue / crimson-pink; these are the tokens `roadmap.mock.html` already uses for the SAME element, so the three assets now agree |
>
> **One disagreement is recorded and NOT resolved here.** `roadmap.mock.html`'s work-TYPE
> legend (`epic` · `story` · `design` · `code` · `test` · `plan`) predates theme.css's
> `--el-type-<work-type>` family and no longer agrees with it — the design system assigns
> `--el-type-design` pink, `--el-type-test` green, where the legend draws them orange and
> teal. The sweep preserved the DRAWN hues (`--el-warning`, `--el-type-subtask`) rather
> than re-mapping the legend, because re-mapping is a design decision and this card only
> moves the declaration layer. `--el-type-code` was the one row where value and role
> already agreed, and it takes that token.
>
> **What stayed a literal, deliberately:** the black-alpha shadows and the canvas
> dot-grid / cell-guide textures (`#0000000a` … `#00000033`). They carry no palette
> colour — the same disposition MOTIR-4352 took with its `--sh-*` block — and `CLAUDE.md`
> § _NEVER INVENT A COLOUR_ names the grid-dot texture and the body backdrop as its own
> exemption. The body backdrop itself did NOT stay: `#efeee9` is now `--el-canvas`
> (`#ecebe7`), the token for the recessed board behind raised cards.
>
> **Renders.** `grid-init` and `edges` re-export `EXACT` (2400×2430 and 2400×2290).
> `roadmap` reports `DRIFT` at 2400×8002 against a committed 2400×8012 — and the drift is
> NOT this diff: the asset AS IT STANDS AT `HEAD` also renders 8002, so the 10px belongs
> to the render-environment gap the committed PNG predates. Nothing reflowed.

- **A11y** — the canvas + chat are labelled regions (`role="application"`,
  `aria-label` — shipped on `PlanningCanvas`); nodes are keyboard-focusable;
  zoom / pan have keyboard equivalents (`+` / `−` / `0` / arrows — shipped);
  decorative icons are `aria-hidden`; the frontier node carries
  `aria-current="step"`; edges are `aria-hidden` (the dependency facts live in
  the node list).

---

## ⭐ Canvas detail surfaces — the quick-view + tier-doc viewer (MOTIR-1351)

`detail-surfaces.mock.html` designs the two DETAIL surfaces the roadmap canvas
**opens**, plus their on-canvas **entry affordances**. The card's mandate is to
**COMPOSE existing designs / components, not redraw them** — `notes.html`
**#82** (reuse the real shipped COMPONENT + its markup, never a stylized
stand-in) and **#95** (ground a composing design in the COMPONENT and its
CONTRACT — not an asset path or the parent story). So every element here is the
real shipped surface, annotated with the component it composes.

> **⚠️ Grounded in the SHIPPED canvas `ProjectRoadmapCanvas` (MOTIR-1194 / PR
> #1398) — two DISTINCT node interactions, do not conflate them:**
>
> 1. **SELECT (click a card) = HIGHLIGHT only.** `ProjectRoadmapCanvas` rings the
>    selected card (`--el-accent-on-surface` + `--el-surface-soft` offset) and
>    lights the dependency it belongs to (its `connectedIds` — the node +
>    everything it links to). Selecting does **NOT** open a detail surface.
>    (**MOTIR-4474** moved the ring, the emphasised edge stroke and its arrowhead
>    off `--el-accent` — the FILL role, whose contrast is guaranteed only against
>    `--el-accent-text` on top of it — onto `--el-accent-on-surface`, the ink. The
>    fill measured 1.24–2.77:1 on `--el-canvas` in four light palettes, under WCAG
>    1.4.11's 3:1. This line described the shipped code and so recorded the same
>    mistake; the pairing is now measured in
>    `tests/theme/canvasEmphasisInkContrast.test.ts`.)
> 2. **A dedicated VIEW button opens the detail** — surfaced **on the selected
>    card**, the same bottom-edge action slot where the shipped **"Open ›" DRILL
>    pill** appears (the canvas renders that pill on a _selected drillable_ card).
>    This card ADDS a **View** button there: a work-item node's View opens the
>    quick-view (MOTIR-1352); a tier station's View opens the tier doc
>    (MOTIR-1355). A drillable selected node shows **both** View + Open ›;
>    `WorkItemNode` keeps its passive `ChevronRight` has-children hint.
>
> So: **select = highlight, View = open detail, Open › = drill.** (Two earlier
> drafts of this mock got the entry wrong — first a hover "Eye", then "selection
> itself opens the detail". Both wrong: selection only HIGHLIGHTS; a dedicated
> View button opens the surface. This is the #82/#95 trap — read the composed
> component's _interaction contract_ — `handleActivate` + `connectedIds` + the
> selected-card action pills — not just its markup.)

### Composed components + their contracts (notes #95)

| Composed thing     | Source (component / asset)                                                                         | Contract this design honours                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| canvas interaction | `ProjectRoadmapCanvas` (`components/planning/ProjectRoadmapCanvas.tsx`, MOTIR-1194)                | click SELECTS = highlight (`connectedIds` lit, rest dim); selected card surfaces action pills ("Open ›" drill shipped; **View** added here); per-level drill-down (MOTIR-1010) |
| canvas card        | `WorkItemNode` (`components/planning/WorkItemNode.tsx`, MOTIR-1194)                                | presentational; fixed `NODE_W 280 × NODE_H 148`; status chip top · tile + id/title body · passive drill `ChevronRight` hint                                                    |
| tier station       | `StationCard` (`components/onboarding/StationNode.tsx`, MOTIR-840)                                 | tier-coloured tile + title/sub + captured rows + state pill; per-tier accent from `TIER_META`                                                                                  |
| work-item peek     | `design/work-items/quick-view.mock.html` (Story 2.5 / 8.8)                                         | reused **1:1**; read-only; the one write path is **Open full page →**                                                                                                          |
| modal shell        | `Modal` (`components/ui/Modal.tsx`)                                                                | `size="xl"` peek shell, `srTitle` (the body owns its heading), X close, `data-surface="modal"`                                                                                 |
| tier-doc render    | `DirectionDocView` (`components/onboarding/DirectionDocView.tsx`, MOTIR-834) + `direction-doc.css` | READ-ONLY editorial render; props `{ doc, availableDocs, onNavigate }`; accent via `--dd-accent`                                                                               |

### The five panels (`detail-surfaces.mock.html`)

| Panel | Surface                | What it draws                                                                                                                                                                                                                              |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Quick-view **entry**   | a **SELECTED** `WorkItemNode` (accent ring) with its connection lit (select = highlight); the selected card's **View** button opens the peek, beside the shipped **"Open ›"** drill pill on a drillable node (a leaf shows **View** alone) |
| **2** | Quick-view **peek**    | the shipped `quick-view` modal (Modal `size="xl"` + the two-column head/main/rail body), reused **verbatim** to confirm the entry → peek wiring                                                                                            |
| **3** | Tier-doc **entry**     | the 4 tier **stations** (`StationCard`) on the canvas; a **SELECTED** station (accent ring) surfaces a **View** button → opens the doc; only PRODUCED tiers carry it                                                                       |
| **4** | Tier-doc **modal**     | the **same** `Modal` shell rendering `DirectionDocView` inside; thin head carries **Open full page**; discovery accent `--el-info`                                                                                                         |
| **5** | Tier-doc **full page** | the read-only route `/projects/[key]/direction/[tier]` (NEW — no shipped route yet) — app shell + **← Back to roadmap** + breadcrumb; `DirectionDocView` at full reading width                                                             |

### Access paths (DRAW THE DOOR — `run.md` design gate)

- **Quick-view:** **select** a work-item node on the canvas (highlights it) →
  click the **View** button on the selected card (panel 1) → peek modal (panel 2)
  → **Open full page** → the work item's `/items/[key]` detail page. **View**
  (open peek) is DISTINCT from the **"Open ›" drill** pill (drillable nodes,
  MOTIR-1010) — both sit on the selected card.
- **Tier-doc:** **select** a produced tier station (highlights it) → click its
  **View** button (panel 3) → tier-doc modal (panel 4) → **Open full page** →
  `/projects/[key]/direction/[tier]` (panel 5) → **← Back to roadmap** returns to
  the canvas.

### New decisions this card makes (resolved from the decision ladder, not asked)

- **A dedicated VIEW button is the entry; selection only highlights.** In the
  shipped `ProjectRoadmapCanvas` (PR #1398), clicking a card SELECTS it = rings it
  and highlights the dependency it's part of (`connectedIds` lit); selection does
  **not** open anything. So the detail surface
  needs its own affordance: this design adds a **View** button on the selected
  card, in the same bottom-edge action slot the shipped **"Open ›"** drill pill
  uses. The builds add it: MOTIR-1352 adds View → quick-view on the work-item
  node; MOTIR-1355 adds View → tier doc on the station. View (open) and Open ›
  (drill) are distinct; a leaf shows View alone. (The onboarding consumer today
  opens a station's doc on bare select; this design refines that to the explicit
  View action so the on-canvas roadmap reads consistently — select highlights,
  View opens.)
- **The tier-doc FULL-PAGE route is NEW** (`/projects/[key]/direction/[tier]`).
  `DirectionDocView` is shipped but rendered in **no app route** today (only the
  onboarding gate embeds it, and PR #1398 renders it only inside the canvas). The
  MOTIR-1355 build adds the route; this design fixes its layout (app shell +
  back/breadcrumb + centred doc, read-only).
- Both surfaces stay **read-only** — the chat is the only edit path (the
  conversation-only model, MOTIR-1100); there is no inline-edit affordance.

### Token / a11y discipline (same rules as the canvas)

- **Colour** via `--el-*` only (inlined light palette, as `quick-view.mock.html`
  does). Status pills + tier tiles put the hue in a **tint background** with
  `--el-text-strong` (AA, finding #35); the selection ring is `--el-accent` with
  an `--el-surface-soft` offset (the shipped `ring-offset`). Tier accents:
  discovery `--el-info`, vision `--el-accent-on-surface`, feasibility
  `--el-success`, validation `--el-warning`; per-tier station tiles use
  `--el-station-tier-*`. Work-item kind tiles use `--el-type-*`.
- **Shape** via element-semantic tokens: card/modal/doc-table = `--radius-card`
  / `--radius-modal`; pills/chips = `--radius-badge`; close/menu rows =
  `--radius-control`; buttons + the "Open ›" drill pill = `--radius-btn`;
  elevation `--shadow-{subtle,card,modal}`. `--radius-pill` only on dots /
  avatars.
- **A11y** — selection is keyboard-reachable on the shipped canvas; the **View**
  and shipped **"Open ›"** drill buttons are labelled `button`s ("View
  &lt;identifier&gt;" / "Open this item's children"); the modal is the shipped
  `Modal` (Radix focus-trap, ESC, `srTitle`); `DirectionDocView` keeps its
  `aria-label` (tier label) + read-only hint; decorative icons `aria-hidden`; the
  full page leads with a back
  affordance + breadcrumb.

---

## ⭐ Scope toggle + sprint-scoped states (MOTIR-1380 / Story MOTIR-1379 — `scope-toggle.mock.html`)

`scope-toggle.mock.html` adds a header **scope control** that switches the SAME
roadmap canvas between **the whole project** (default) and **the active sprint**.
The card's mandate is to **COMPOSE the shipped canvas, not redraw it** (`notes.html`
**#82**/**#95**): the canvas (`ProjectRoadmapCanvas`, MOTIR-1194; design MOTIR-1009
/ `roadmap.mock.html`) is reused UNCHANGED — same node treatment, drill, edges,
zoom, and "you are here" overlay. The only NEW pixels are the toggle, the
per-scope subtitle, the no-active-sprint empty state, and the narrowed root-level
**node set** (the topmost in-sprint items). The behaviour the toggle depicts is defined
by the backend read subtask (the sprint-scoped read re-rooted at the TOPMOST
in-sprint items, MOTIR-1381), which this card `relates_to` and grounds in (not
invented here).

### Composed components + their contracts (notes #95)

| Composed thing | Source                                                     | Contract this design honours                                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scope toggle   | `Segmented` (`components/ui/Segmented.tsx`, Subtask 3.3.5) | labelled `role="group"`; each option a real `<button aria-pressed>`; `--el-tabnav-track` track, active = `--el-page-bg` + `--shadow-subtle` raised fill, leading glyph takes `--el-tabnav-active`                                                                                                    |
| canvas + nodes | `ProjectRoadmapCanvas` / `WorkItemNode` (MOTIR-1194)       | reused unchanged; status pill · `--el-type-*` kind tile · id/title · subtree progress meter (`--el-success` fill on `--el-muted` track) · passive drill `ChevronRight`; only the root-level FED node set changes (re-rooted at the topmost members) — meters/drill are the normal full-subtree reads |
| empty state    | `EmptyState` (`components/ui/EmptyState.tsx`)              | `Card` + centred icon (`--el-icon-muted`) + serif title + `--el-text-subtitle` description; the no-active-sprint case                                                                                                                                                                                |
| page header    | `app/(authed)/roadmap/page.tsx` `<header>` (MOTIR-1011)    | serif `text-2xl` `<h1>` + `--el-text-muted` subtitle; the toggle is added to this header by the frontend's client wrapper (MOTIR-1382)                                                                                                                                                               |

### The four panels (`scope-toggle.mock.html`)

| Panel | Scope/state             | What it draws                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Whole project (default) | header with the `Segmented` toggle (**Whole project** selected) + the project subtitle; the full root level (every epic), whole-subtree meters (Epic 7 → `12 / 40`)                                                                                                                                                                                                          |
| **2** | Active sprint           | toggle flipped to **Active sprint**; subtitle = sprint name + goal + a quiet **Sprint scope** chip; the canvas RE-ROOTED at the topmost in-sprint items — a member story + the in-sprint subtask of a non-member story show as roots, the epics + non-member ancestors elided; below a root the tree is the normal unscoped read (a root story's meter is its whole subtree) |
| **3** | No active sprint        | toggle on **Active sprint** but no sprint running → an in-canvas `EmptyState` (**Goal** icon, **"No active sprint"**, a one-line hint); the toggle stays available, Whole-project scope unaffected                                                                                                                                                                           |
| **4** | Control + access path   | the `Segmented` toggle states (default / hover / sprint-active) + the **Roadmap** primary left-nav entry the page is reached from (MOTIR-1011)                                                                                                                                                                                                                               |

### Sprint-scope dependency signal — "not in sprint", not "cross-story" (MOTIR-1379)

The roadmap's off-level dependency signal (MOTIR-1331) MEANS something different in
sprint scope, so it is RE-LABELLED. In **project** scope a `blocked_by` edge to an
item on another level is the **cross-story tangle** (a bad plan — the red edge, the
ghost anchor "in {story} ↗", and the node's red **"blocked elsewhere"** flag). In **sprint**
scope the same edges become a **sprint-validity** signal (mirroring the MCP
`validate_sprint` rule): a blocker is a problem ONLY when it is **not done AND not in
the active sprint**. So:

- a **done** dependency, or one **already in the sprint**, is SATISFIED → it is NOT
  drawn (no edge, no anchor, no flag) — the sprint view stays focused on real risks;
- an **out-of-sprint, open** dependency is the problem → the red edge + a ghost
  anchor reading **"not in this sprint ↗"** + the node's red flag **"not in sprint"**;
- the edge **legend**'s warning row reads **"not in sprint" — "not done & outside the
  sprint"** (vs. project scope's "blocked elsewhere" — "the blocker sits elsewhere in the plan").

This fixes the mis-label where two items in the SAME story showed as "cross-story"
in sprint scope (they are siblings, not cross-story — the real issue is only whether
the open dependency is inside the sprint). Same red `--el-danger` / `--el-warning`
tokens; only the copy changes.

### Exact copy (the labels + strings the frontend ships — MOTIR-1382 `messages/en.json`)

- **Toggle option labels:** `Whole project` (default, selected) · `Active sprint`.
  (Distinct enough to avoid the getByRole superstring pitfall, `notes.html`
  aria-selector entries — neither is a substring of the other.)
- **Whole-project subtitle:** the existing `roadmap.subtitle` — `{project}'s roadmap`.
- **Active-sprint subtitle:** the sprint's **name** + goal — e.g. `Sprint 32 · Three Epic-7 stories`;
  the trailing **Sprint scope** chip marks the canvas as scoped.
- **No-active-sprint empty state:** title `No active sprint`; description
  `This project has no sprint running right now. Start a sprint from the board to see its slice of the roadmap, or switch back to Whole project.`

### Access path (DRAW THE DOOR — `run.md` design gate)

The Roadmap page is reached from the shipped **Roadmap** primary left-nav entry
(MOTIR-1011, panel 4) — there is **no new route or nav affordance**. The scope
toggle lives **in that page's header**, right-aligned beside the title/subtitle
(panels 1–3 draw it in place at the page's real width above the canvas).

### Token / a11y discipline (same rules as the canvas)

- **Colour** via `--el-*` only (light palette inlined, as the sibling mocks do).
  The Segmented track is `--el-tabnav-track` / `--el-border`; the active option is
  the raised `--el-page-bg` fill + `--shadow-subtle` with `--el-text-strong` text
  and the `--el-tabnav-active` glyph; inactive options are `--el-text-secondary`.
  The **Sprint scope** chip puts the hue in a `--el-tint-lavender` background with
  `--el-text-strong` text (AA, finding #35) and an `--el-accent-on-surface` glyph;
  never a page-level tint. Node status pills / kind tiles / progress meters are the
  shipped `WorkItemNode` tokens, unchanged.
- **Shape** via element-semantic tokens: the Segmented track = `--radius-btn`, each
  option = `calc(--radius-btn - 2px)` (nests in the track at any style) sized by
  `--height-control` + `--spacing-control-x`; the scope chip = `--radius-badge`;
  cards/canvas = `--radius-card`; elevation `--shadow-{subtle,card}`. No raw
  `rounded-*`/`p-*`/`h-*`.
- **A11y** — the toggle is the shipped `Segmented`: a labelled `role="group"` whose
  options are keyboard-operable `<button aria-pressed>`s announced as toggles; the
  selected scope carries `aria-pressed="true"`. The no-active-sprint surface is the
  shipped `EmptyState` (`Card` + heading + description); decorative icons are
  `aria-hidden`. Switching scope is a client-island refetch (the canvas reload),
  not a `router.refresh()` (the page-state contract; MOTIR-1382).

---

## ⭐ Refresh control + URL-addressable scope (MOTIR-1540 / Story MOTIR-1539 — `roadmap-refresh.mock.html`)

`roadmap-refresh.mock.html` adds two usability affordances to the SAME shipped
roadmap header: a **refresh control** that re-fetches the canvas in place, and
making the existing scope toggle **URL-addressable** (`/roadmap?scope=sprint`).
Like the scope toggle (MOTIR-1380), this card's mandate is to **COMPOSE the shipped
header + canvas, not redraw it** (`notes.html` **#82**/**#95**): the
`ProjectRoadmapCanvas` engine (MOTIR-1194) and the `Segmented` scope toggle
(MOTIR-1380) are reused UNCHANGED. The only NEW pixels are the refresh control and
its loading affordance; the URL-addressable scope is a **behaviour change with NO
new pixels** (the toggle looks identical). The refresh mechanism is grounded in the
canvas's SHIPPED `reloadKey` prop (`ProjectRoadmapCanvas.tsx:56` — its load effect
refetches the current focus level via `loadLevel(focusId)` on a `reloadKey` bump),
which the frontend code subtask (MOTIR-1542) drives; this design `relates_to` the
two code subtasks (MOTIR-1541 URL scope, MOTIR-1542 refresh) that define the
behaviour, not invented here.

### Composed components + their contracts (notes #95)

| Composed thing  | Source                                                                                       | Contract this design honours                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| refresh control | `Button` (`components/ui/Button.tsx`) — `variant="secondary"`, icon-only, lucide `RefreshCw` | a real `<button>` with an `aria-label`/`title`; idle = `--el-text-secondary` glyph on a transparent fill with an `--el-border-strong` edge, `--radius-btn`; hover = `--el-surface` fill; focus-visible = the Button base `--focus-ring-color` ring |
| loading state   | `Spinner` (`components/ui/Spinner.tsx`) — the Button's own `loading` affordance              | the glyph is swapped for the inline `Spinner`, the button is `disabled` + `aria-busy="true"` + `opacity 0.55`; NO bespoke markup (reuses `Button loading`)                                                                                         |
| scope toggle    | `Segmented` (`components/ui/Segmented.tsx`, MOTIR-1380)                                      | reused UNCHANGED — visually identical; the ONLY change is that selecting an option now also writes `?scope=sprint` to the URL (behaviour, not pixels)                                                                                              |
| canvas + nodes  | `ProjectRoadmapCanvas` / `WorkItemNode` (MOTIR-1194)                                         | reused unchanged; refresh drives its SHIPPED `reloadKey` prop → an in-place refetch of the current focus level (drill / breadcrumb / zoom / pan preserved), NOT a remount                                                                          |
| page header     | `app/(authed)/roadmap/page.tsx` `<header>` (MOTIR-1011)                                      | the refresh control joins the right-aligned control cluster after the `Segmented` toggle; the server page seeds the initial scope from `searchParams` (MOTIR-1541)                                                                                 |

### The four panels (`roadmap-refresh.mock.html`)

| Panel | State                    | What it draws                                                                                                                                                                                                                                                            |
| ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Refresh control — idle   | the full roadmap header with the refresh `Button` (secondary, `RefreshCw`) in the right cluster AFTER the scope toggle, matching the toggle's 40px outer height; the canvas at the root level below, unchanged                                                           |
| **2** | Refreshing (loading)     | the control in its loading state (`Spinner`, `disabled`, `aria-busy`); a small **"Refreshing…"** toast + a faint veil over the canvas; the breadcrumb still reads **Project root / Epic 7** — proving the in-place refetch (`loadLevel(focusId)`) does NOT reset to root |
| **3** | Refresh control — states | the four control states side by side: idle / hover / focus-visible (the ring) / loading (spinner) — one primitive, four states                                                                                                                                           |
| **4** | URL-addressable scope    | two address bars — `/roadmap` (Whole-project selected) and `/roadmap?scope=sprint` (Active-sprint selected) — showing the toggle state mirrored in the URL; a behaviour note, the toggle itself unchanged                                                                |

### Refresh = IN-PLACE refetch, not a page reload (the interaction, grounded in shipped reality)

The gap this fixes: the roadmap canvas caches each level in a client `useRef` Map
(`WorkItemRoadmap.tsx` `cacheRef`), so the only way to pick up changed work items is
a full browser reload. The refresh control instead **clears that cache and bumps the
canvas's SHIPPED `reloadKey`** (`ProjectRoadmapCanvas.tsx:56`), whose load effect
re-runs `loadLevel(focusId)` for the CURRENT level — so the user's drill position,
breadcrumb, and zoom/pan survive (panel 2). It is deliberately NOT the scope-change
remount (`key={scope}`), which resets the view. The loading state is driven by the
REAL fetch-completion signal (the canvas's per-level load state), never a fixed
timer — the same authoritative-signal discipline the E2E relies on.

### URL-addressable scope — the standard view-state convention (MOTIR-1541)

Selecting **Active sprint** writes `?scope=sprint` to the URL
(`router.replace`, `scroll:false`); the default **Whole project** omits the param
(canonical `/roadmap`). The server page reads the initial scope from `searchParams`,
so a deep-linked / reloaded / shared `?scope=sprint` opens directly in sprint scope,
and browser Back/Forward moves scope. This matches how mature PM tools (Linear /
Jira / GitHub Projects) make a view's state shareable — a query param on one route,
not a distinct `/roadmap/sprint` path. No pixels change; the sprint roadmap simply
gains its own URL.

### Exact copy (the strings the frontend ships — MOTIR-1542 `messages/en.json` + `zh.json`)

- **Refresh control label / tooltip:** `Refresh roadmap` (the `aria-label` + `title`).
  Distinct enough to avoid the getByRole superstring pitfall (`notes.html`
  aria-selector entries).
- **Refreshing toast (optional in-canvas affordance):** `Refreshing…`.
- **Loading `Spinner` label:** the shipped `Spinner`'s default `Loading`.
- New `roadmap` keys land in BOTH `messages/en.json` AND `messages/zh.json` in the
  same PR (the i18n-catalog en↔zh parity gate); the scope toggle reuses its existing
  MOTIR-1382 strings unchanged.

### Access path (DRAW THE DOOR — `run.md` design gate)

The refresh control is an **in-header affordance on the EXISTING Roadmap view**,
reached from the shipped **Roadmap** primary left-nav entry (MOTIR-1011) — there is
**no new route or nav affordance** (a control inside a view is scoped to that view;
the URL-addressable scope adds a query param to the same `/roadmap` route, not a new
door). Panels 1–2 draw the control in place at the page's real width; panel 4 shows
the URL the scope produces.

### Token / a11y discipline (same rules as the canvas)

- **Colour** via `--el-*` only (light palette inlined, as the sibling mocks do). The
  refresh `Button` idle = `--el-text-secondary` glyph, `--el-border-strong` edge,
  transparent fill; hover = `--el-surface` fill + `--el-text` glyph; loading uses the
  Button's `disabled` opacity + the `Spinner` (`border-current`, so it inherits the
  glyph colour). The refreshing toast is a `--el-page-bg` pill with `--el-border` +
  `--shadow-card` and an `--el-accent-on-surface` spinner; the veil is a
  `color-mix()` over `--el-page-bg` (palette-derived, no raw hue). The `?scope=sprint`
  fragment in the address-bar study is `--el-accent-on-surface`. No invented hex — the
  only raw values are the shared non-semantic canvas grid-dot + body backdrop the
  sibling mocks already use.
- **Shape** via element-semantic tokens: the refresh button = `--radius-btn` sized to
  `--height-btn-md` (40px, matching the `Segmented` track's outer box so they align);
  the toast = `--radius-badge`; canvas/cards = `--radius-card`; elevation
  `--shadow-{subtle,card}`. No raw `rounded-*`/`p-*`/`h-*`.
- **A11y** — the refresh control is a real `<button>` with `aria-label`/`title`
  `Refresh roadmap`; in flight it sets `aria-busy="true"` + `disabled` and exposes the
  `Spinner`'s `role="status"` `Loading`; decorative icons are `aria-hidden`. Refresh is
  a client-island refetch (the canvas `reloadKey`), NOT a `router.refresh()`; the scope
  write is a shallow `router.replace` (the page-state contract). No nested interactive
  elements (the icon is an inline `<svg>` inside the single button).

---

## ⭐ Ready-to-start highlight (MOTIR-1416 / Story MOTIR-1415 — `ready-highlight.mock.html`)

`ready-highlight.mock.html` adds a quiet highlight marking a roadmap node that is
**ready to start** — not yet started/done, and every item it is `blocked_by` is done
(no open blocker; the shipped `ReadinessDto.ready` / dispatch-ready set). It makes the
actionable FRONTIER obvious. COMPOSES the shipped `WorkItemNode` (MOTIR-1194,
`notes.html` #82/#95) — the card, status pill, kind tile, identifier/title, drill
chevron and "you are here" pill are the real shipped structure; only the ready
treatment is new. Works in BOTH project and sprint scope (the readiness rule is
scope-independent).

### The treatment (two parts, both `--el-success`)

1. **The "Ready" pill** — in the status slot, REPLACING the dim "To do" pill (a ready
   item IS a to-do whose blockers are all done, so "Ready" is the informative label).
   `--el-tint-mint` background + `--el-text-strong` text (AA, finding #35) + a
   `CirclePlay` glyph in `--el-success`.
2. **A success LEFT accent bar** — a 3px `--el-success` inset bar
   (`box-shadow: inset 3px 0 0`, respecting `--radius-card`) so a ready node is
   scannable across a dense canvas at zoom — WITHOUT a full border that would read
   like the accent "you are here" frame.

### Distinct from the existing node affordances (the AC)

The ready highlight fires on **exactly one** node state — a startable, unblocked item —
and is deliberately distinct from each existing signal by **hue + shape**:

| Signal          | Treatment                                        | Hue             |
| --------------- | ------------------------------------------------ | --------------- |
| **Ready** (new) | "Ready" pill + 3px left accent bar               | `--el-success`  |
| "You are here"  | accent BORDER + accent map-pin pill              | `--el-accent`   |
| dependency flag | red chip ("blocked elsewhere" / "not in sprint") | `--el-danger`   |
| status pill     | tinted chip, per STATUS (see below)              | per-status tint |

> **⚠️ AMENDMENT — 2026-09-11, MOTIR-5141. THE STATUS PILL IS PER-STATUS, AND THE TINT
> FAMILY GAINED A SEVENTH MEMBER.** The row above said _"To do / In progress / Done"_,
> which was the canvas's whole status vocabulary when it was written. It is not any more:
> `lib/workflows/canvasStatusMeta.ts` resolves the chip by status KEY first and by
> lifecycle CATEGORY second, and the default workflow now ships NINE statuses. The mapping
> it renders:
>
> | status               | glyph                      | tint                          |
> | -------------------- | -------------------------- | ----------------------------- |
> | `todo` · `cancelled` | `CircleDashed` · `XCircle` | `--el-muted` (the quiet chip) |
> | `blocked`            | `Ban`                      | `--el-tint-peach`             |
> | `in_progress`        | `CircleDot`                | `--el-tint-sky`               |
> | `implemented`        | `CircleEllipsis`           | `--el-tint-rose`              |
> | `planning`           | `CircleDotDashed`          | `--el-tint-yellow`            |
> | `in_review`          | `Eye`                      | `--el-tint-lavender`          |
> | **`approved`**       | **`CircleCheck`**          | **`--el-tint-sage`** ← new    |
> | `done`               | `Check`                    | `--el-tint-mint`              |
>
> **`--el-tint-sage` is the SEVENTH member of a family that had six**, and it was added
> because the six were fully spent — `canvasStatusMeta.ts`'s header records `planning`
> taking _"the one remaining unspent tint"_. Borrowing a tint another status holds would
> re-create `MOTIR-3170`, the bug filed when the canvas rendered two statuses as one. The
> value is measured in `design/boards/design-notes.md` § _Approved — the ninth board
> column_: worst ΔE2000 6.0 against the other six plus `--el-muted` across all twenty
> palette × theme contexts. ⚠️ **No suite enforces that floor for this family**, so it is a
> hand measurement and a palette change does not re-run it.
>
> A status with no row of its own still falls back to its CATEGORY, and an unrecognised one
> to the neutral chip — an honest unknown rather than an impersonation of To Do.

An in-progress or done node is NOT ready (already started/finished); a to-do with an
open blocker is NOT ready (the dim "To do" pill stays). The mock's panel 1 shows the
ready node beside all four non-ready states; panel 2 is the anatomy.

### Exact copy + tokens

- **Pill label:** `Ready`; glyph `CirclePlay` (`--el-success`).
- **Colour:** `--el-tint-mint` / `--el-text-strong` / `--el-success` only (no Tier-0
  `--color-*`). **Shape:** `--radius-badge` (pill) + `--radius-card` (the card the
  inset bar rides). No raw `rounded-*` / `p-*`.
- The code subtask (MOTIR-1417) renders this when the per-level roadmap read returns
  `ready: true` for a node (and the node is not the "you are here" / done state).

---

## ⭐ Full-screen mode (MOTIR-1423 / Story MOTIR-1420 — `full-screen.mock.html`)

`full-screen.mock.html` adds a **full-screen** affordance to the roadmap canvas: an
**Expand** button takes the canvas to full screen so a viewer can use the whole
display for a large tree; **ESC exits**. COMPOSES the shipped canvas + overlay chrome
(`ProjectRoadmapCanvas` / `PlanningCanvas`, MOTIR-1194) — the breadcrumb (top-left),
search (top-right), and the zoom + fit-view cluster (bottom-left) are the real shipped
controls; only the Expand/Exit button + the ESC hint are new (`notes.html` #82/#95).

### The control

- **Placement:** the Expand button joins the **top-right** cluster, beside the shipped
  search — an `--el-surface` icon button (`--radius-btn`, `--shadow-card`) the size of
  the other overlay controls (`--height-control`).
- **Glyph + label:** **Maximize** (corner brackets) — deliberately UNLIKE the
  bottom-left **fit-view** control's `Maximize2` (diagonal arrows), which only resets
  zoom. Accessible name **"Enter full screen"**.
- **Full-screen state:** the button flips to **Minimize** (accessible name **"Exit full
  screen"**) and a quiet **"Press `Esc` to exit full screen"** hint chip appears
  top-centre (a `<kbd>` on `--el-muted` / `--radius-kbd`). The other overlay controls
  stay reachable; pan / zoom / drill keep working.

### Behaviour (the code subtask, MOTIR-1424, decides + verifies)

The browser **Fullscreen API** on the canvas container is the preferred approach — the
OS chrome hides and **ESC exit is native** — with a `fullscreenchange` listener syncing
the button state; a fixed full-viewport overlay + a manual `keydown` Escape handler is
the fallback if the Fullscreen API doesn't compose with the app shell. Works in both
project and sprint scope.

### Token / a11y discipline

Colour via `--el-*` only; shape via `--radius-btn` (the button) / `--radius-kbd` (the
hint) / `--radius-control` (the overlay icon buttons) — no Tier-0 `--color-*` or raw
`rounded-*`. The Expand/Exit button is a labelled `<button>` (icon-only → `aria-label`);
decorative glyphs are `aria-hidden`. The two panels (embedded + full screen) are in the
mock.

---

## ⭐ Locate control (MOTIR-1427 / Story MOTIR-1421 — `locate.mock.html`)

`locate.mock.html` adds a **Locate** affordance to the roadmap canvas: a button that
**recentres the viewport on the actionable node** so a viewer never has to hunt for where
to work next. COMPOSES the shipped canvas + overlay chrome (`ProjectRoadmapCanvas` /
`PlanningCanvas`, MOTIR-1194) — the breadcrumb (top-left), search + Expand (top-right,
MOTIR-1420), and the zoom + fit-view cluster (bottom-left) are the real shipped controls;
only the Locate button + its position hint are new.

### What it targets

- **Priority — the "you are here" frontier first.** If the level has the in-progress
  current-position node (MOTIR-1013), Locate centres + highlights THAT (a single
  destination — no cycling).
- **Otherwise the READY nodes** (the mint "Ready" highlight, `RoadmapNodeDto.ready`,
  MOTIR-1417). With **multiple ready nodes**, repeated clicks **cycle** to the next ready
  node in a stable order and **wrap** to the first after the last.
- **Disabled** when there is NEITHER a frontier NOR a ready node on the level.

### The control

- **Placement:** the Locate button joins the **bottom-left** cluster, beside the shipped
  zoom + fit-view (it is a viewport-navigation control, so it lives with them) — an
  `--el-surface` icon button (`--radius-btn`, `--shadow-card`, `--height-control`).
- **Glyph + label:** **LocateFixed** (a crosshair), deliberately UNLIKE the `Maximize` /
  `Maximize2` of Expand + fit-view. Accessible name **"Locate the current item"** (or
  **"Locate the next ready item"** in the cycling state).
- **Cycling signal:** when there is more than one ready node, a quiet **"n of m"** position
  hint chip (`--el-surface`, `--radius-badge`, mono) sits beside the button so the cycle
  reads. The centred node carries the **accent focus ring** (the `data-highlighted`
  treatment the `/`-search locate already applies — so locate visually marks AND is
  assertable on the same attribute).
- **Disabled state:** `aria-disabled`, faint `--el-text-faint`, with a tooltip
  ("Nothing to locate — no in-progress or ready item on this level.").

### Behaviour (the code subtask, MOTIR-1428, builds it)

Pure-client: targets are read from the CURRENT level's already-loaded nodes (the active
frontier + the `ready` flags), so no new fetch. Centring reuses the shipped pan-to-node
machinery — set the focused id + bump `focusNonce` so `PlanningCanvas` recentres, and set
the highlight so the node lights up. The cycle cursor is a ref over the ordered ready-id
list, **reset when the level changes**. Gated behind a `locatable` prop the work-item
roadmap passes (like `fullScreenable`, MOTIR-1420); the onboarding canvas — which has no
work-item frontier / ready flags — does not show it.

### Token / a11y discipline

Colour via `--el-*` only (the accent ring for the located node; mint for Ready;
lavender for the frontier pill); shape via `--radius-btn` (button) / `--radius-control`
(overlay icon buttons) / `--radius-badge` (the hint chip) — no Tier-0 `--color-*` or raw
`rounded-*`. The Locate button is a labelled `<button>` (icon-only → `aria-label`);
decorative glyphs are `aria-hidden`. The three panels (frontier · ready-cycling ·
disabled) are in the mock.

---

## ⭐ Done & ready card styles (MOTIR-1434 / Story MOTIR-1422 — `done-ready.mock.html`)

`done-ready.mock.html` restyles TWO node states of the roadmap `WorkItemNode` (MOTIR-1194)
so each reads at a glance AND **when zoomed out**, and the two are **clearly distinct** from
each other (and from the accent "you are here" + the red blocked flag). COMPOSES the shipped
node — does NOT redraw it.

### The problem it fixes

Ready shipped (MOTIR-1417) as a `--el-success` **3px left bar** — a hairline that all but
disappears when the canvas is zoomed out, AND the same success-green a done border would use,
so done & ready would read identically. So BOTH signals move **into the card body**, where a
fill survives scale and the two can diverge.

### The two treatments

- **Ready (reworked):** the whole card fills with `--el-tint-mint` (was the 3px
  `--el-success` left bar) + the "Ready" pill (`CirclePlay`, `--el-success` icon) stays. The
  title goes `--el-text-strong` for AA on the tint. A ready node now **glows mint** at any zoom.
- **Done (new):** the card takes a **distinct palette tint — `--el-tint-sky`** (a clearly
  different colour from the white todo card AND the mint ready card), `--el-border` + a flat
  `--shadow-subtle`, a **struck**, `--el-text-muted` title, and a **solid dark "Done" stamp**
  (`bg --el-text-secondary` / `text --el-text-inverted` + a `Check`). The stamp is deliberately
  **NOT mint** (so it can't be mistaken for ready) AND far heavier than the light `--el-muted`
  "To do" chip (so done can't be mistaken for **todo** — the redo fixed a too-similar pair). The
  tint fill is the zoom-out signal. **Why a tint, not an invented colour:** `--el-tint-*` are
  PALETTE tokens, so the four state colours flip together under `data-palette` and the palette
  author keeps the six tints mutually distinct — so done stays distinct from ready under every
  palette. An invented hex / `color-mix` over a raw hue would NOT swap (forbidden — see the
  colour rule).
- **Mint (ready) vs sky (done)** is a clear colour contrast that holds at any zoom; the dark
  "Done" stamp vs the light "To do" chip separates done from todo.

### Precedence + boundaries

Done and ready never co-apply to one node; the accent **"you are here"** frontier (MOTIR-1013)
still wins, and the red **cross-blocked / not-in-sprint** flag is louder than both. The data is
already shipped: `RoadmapNodeDto.isDone` (own done-ness) + `RoadmapNodeDto.ready` (MOTIR-1417) —
so the code subtask only plumbs `isDone` like `ready` and restyles; no backend change.

### Token / a11y discipline

Colour via `--el-*` only — **done avoids `--el-success`** (ready's hue); the mint tint carries
`--el-text-strong` for AA. Shape via `--radius-card` / `--radius-badge` / `--radius-control` — no
Tier-0 `--color-*` or raw `rounded-*`. The two panels (the four states at 1× · a zoomed-out
before/after) are in the mock.

---

## ⭐ Work-type: the MANUAL / HUMAN node distinction (MOTIR-1641 / 8.8.35 — `node-worktype.mock.html`)

`node-worktype.mock.html` adds ONE element to the roadmap `WorkItemNode` (MOTIR-1194): a compact
**"Manual" work-type chip**, so a `type: manual` (executor `human`) item reads as DISTINCT on the
canvas — the item a PERSON must pick up, not an agent. COMPOSES the shipped work-type language;
does NOT redraw the node or invent a visual.

### The problem it fixes

The node shows the item's KIND (epic/story/subtask, via the kind tile) but never its work TYPE, so
a `manual` item is pixel-identical to a `code` one — invisible on the very surface where you scan
for what needs YOU.

### The treatment

- A **"Manual" chip** on the node BODY's identifier line (right-aligned) — **not** the top row: the
  lucide **`Hand`** glyph in **`--el-type-manual`** (= `--color-stone`) + the label, on the shipped
  chip tint
  `color-mix(in srgb, var(--el-type-manual) 18%, var(--el-page-bg))`. This is the SHIPPED
  work-type language verbatim — `components/issues/WorkItemTypeChip.tsx` /
  `lib/issues/workItemTypeMeta.ts`, the same recipe the ready-list manual design uses
  (`design/ready/work-type-manual.mock.html`, 8.8.5 / 8.8.10). No new hue, no new glyph.
- **Trigger:** the shipped predicate `executor === 'human' || type === 'manual'`
  (`lib/dto/ready.ts`) — the SAME one the ready-list _Show instruction_ keys on, so the two
  surfaces agree on what "manual" means.
- **One canvas adaptation:** a hairline `--el-border` (tinted a touch by the hue) so the chip lifts
  off EVERY node fill — surface / `--el-tint-sky` (done) / `--el-tint-mint` (ready) / `--el-muted`
  (not-in-sprint). The ready-list chip sits on a white row and needs none; this is a variant, not a
  redraw.

### Manual-ONLY, not a chip on every type (justified deviation)

The denser list / tree / ready rows show the type chip on EVERY row (8.8.9 / 8.8.10); the canvas
deliberately shows it **only for manual/human** nodes. The roadmap is a dispatch-scanning surface —
a chip on every node of a pannable canvas is clutter, and the ask is that _manual_ stands out.
Agent-run nodes stay clean; the human-gated ones pop. (Rung-1 justified deviation: a concrete use
case — canvas legibility + "spot what needs a person" — earns the divergence.)

### Why the body id line, not the top row

The top row is already contended — the status pill on the left, and on the right the **not-in-sprint**
tag / the **cross-blocked** flag / the drill chevron. A 280-wide node cannot hold the status pill AND
a labelled Manual chip AND one of those tags on one line (the first draft wrapped the "To do" pill).
So the chip drops to the **identifier line in the body**, which has its own room and is untouched by
the top-row tags — the two **never share a row**, under any state. The title keeps its two-line clamp
below.

### Precedence + boundaries (composes with every `data-node-state`)

Because the chip lives in the body and **never touches the card fill, border, or the status row**, it
rides cleanly under every state chrome (sheet 2): the `cross-blocked > here > done > ready >
not-in-sprint > normal` precedence owns the fill / border / status row, the chip owns the id line —
so the two loud status-row tags (**not in sprint**, **blocked elsewhere**) keep their full room.
**Why a chip, not a card-fill wash:** the fill washes are
reserved for STATUS (done `--el-tint-sky` / ready `--el-tint-mint`), because status is the primary
scan axis and a wash survives zoom-out where a pill fades (MOTIR-1422); a type wash would collide
with those and overload the fill. The chip is the honest altitude for a secondary, legible-zoom
hint — exactly how type is shown everywhere else in the app.

### Access path

None new — the roadmap view (`app/(authed)/roadmap/page.tsx`) is already a first-class nav entry;
this only changes an existing node's appearance. Build: MOTIR-1642 threads work
`type` / `executor` through the roadmap read seam (`app/api/projects/[key]/roadmap/route.ts` →
`lib/planning/roadmapClient.ts` → `lib/planning/projectCanvasModel.ts`) and renders this treatment
in `components/planning/WorkItemNode.tsx`.

### Token / a11y discipline

Colour via `--el-*` only (`--el-type-manual` + a `color-mix` over `--el-*` / `--el-page-bg`); label
`--el-text-strong` for AA on the light stone tint. Shape via `--radius-badge` + `--spacing-chip-*` —
no Tier-0 `--color-*` or raw `rounded-*`. Two sheets in the mock (the agent-vs-human pair + a zoom
row; the chip under all six node states).

---

## ⭐ The auto-descended ARRIVAL state (MOTIR-1805 / Story MOTIR-1803 — `auto-drill.mock.html`)

`auto-drill.mock.html` draws the state the canvas is in when it **arrives already drilled** — the
one state no sheet in this area covered, because every drilled panel drawn before it (the sheet-6
drill-down chain above) is the _result of a click_. Story MOTIR-1803 makes a level that resolves to
**exactly one drillable node** descend into that node automatically, so a user can now land in a
drilled view they never navigated to. Unaddressed, that reads as "the roadmap lost my sprint's top
level."

**This sheet COMPOSES; it does not redraw.** The canvas engine + layout (`roadmap.mock.html`,
MOTIR-1009 / build MOTIR-1194), the edge language (`edges.mock.html`, MOTIR-1331), the grid + init
arrangement (`grid-init.mock.html`, MOTIR-1333), the scope toggle (`scope-toggle.mock.html`,
MOTIR-1380 / build MOTIR-1382) and the refresh control (`roadmap-refresh.mock.html`, MOTIR-1540) are
all shipped designs this sheet cites and reuses unchanged. The node cards are the shipped
`WorkItemNode`. The breadcrumb + Back overlay mirrors the RUNNING markup in
`components/planning/ProjectRoadmapCanvas.tsx` verbatim rather than restyling it.

### The condition, and where it comes from

The sprint-scoped per-level read (MOTIR-1381) re-roots the root level at the **topmost in-sprint
members**. When a sprint commits to one story's subtree — the common shape, and this project's own
_Journey D · The Motir CLI_ sprint, where 14 of 15 items sit under MOTIR-809 — that root level is a
**single node**, and the whole sprint hides one drill behind it. Whole-project scope hits the same
degenerate case on a single-epic project.

### DECISION 1 — the skipped level is carried by the **breadcrumb alone**

No hint banner, no tell on the crumb, **no new `roadmap.canvas.*` string** — and therefore no
`messages/en.json` + `messages/zh.json` addition for the code card. Three reasons:

1. The treatment is **information-preserving on its own**: the crumb names the skipped ancestor and
   is one click from restoring it, and the shipped `drilled = crumbs.length > 0` gate already
   renders the overlay the moment the crumb stack is non-empty — the arrival needs **no new chrome
   to be legible**.
2. The rung-1 precedent the parent story is grounded in — VS Code's `explorer.compactFolders` —
   adds no separate explanation either.
3. A banner would make the arrival a **special mode**, which is the opposite of this story's
   position: an auto-descend must produce an _ordinary drilled view_. Panel C draws the manual drill
   and the auto arrival side by side to make that identity the visible claim.

### DECISION 2 — the crumb LABEL must become `identifier · title` (a required delta for MOTIR-1807)

Decision 1 is only true if the crumb actually **names** the skipped level. The shipped label does
not: `components/planning/workItemLevel.tsx` sets `crumbLabel: item.identifier`, so the breadcrumb
reads `Roadmap › MOTIR-809`. On a _manual_ drill that is sufficient — the user just read the card
they clicked. On an _arrival_ nobody clicked, a bare key **references** the skipped level without
naming it, and "the breadcrumb alone carries it" would be false. Principle #18 (review at the Story
level, by a non-technical reader) makes an opaque key the wrong carrier.

So this design specifies, and MOTIR-1807 must implement:

| Change                                                                                 | Where                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `crumbLabel: item.identifier` → `` crumbLabel: `${item.identifier} · ${item.title}` `` | `components/planning/workItemLevel.tsx`               |
| `Crumb`'s `max-w-[12rem]` → `max-w-[18rem]`                                            | `ProjectRoadmapCanvas.tsx` (the `Crumb` helper)       |
| the overlay's `max-w-[min(36rem,…)]` → `max-w-[min(44rem,…)]`                          | `ProjectRoadmapCanvas.tsx` (the `drilled &&` `<nav>`) |

It applies to **manual and auto crumbs identically**, so no special mode is introduced and
MOTIR-1807's "crumb label identical to a hand-drilled one" criterion still holds exactly. Overflow
stays the shipped answer — `truncate` plus the existing native `title={label}` tooltip; a
three-crumb chain ellipsises the last crumb **by design** (not a second line, not a smaller font).
Nothing else about the breadcrumb changes: Back control, separators, `aria-current="page"`, the
`aria-label={t('breadcrumb')}` nav, the focus ring and every token are as shipped.

### The six panels (`auto-drill.mock.html`)

| Panel | State                          | What it draws                                                                                                                                                                                                           |
| ----- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | The arrival, through its door  | left-nav **Roadmap** entry → the `Segmented` scope toggle on **Active sprint** → the canvas painting **already drilled**, breadcrumb + Back present on first paint                                                      |
| **B** | The skipped-level treatment    | the breadcrumb anatomy: shipped identifier-only crumb (rejected) vs. `identifier · title` (this design) vs. the focus-visible root crumb — plus the decision table the code card implements                             |
| **C** | Manual drill **vs.** arrival   | the two routes in, side by side, pixel-identical — the design position that auto-descend is not a mode; the descent must reuse `handleDrill`'s transition so nothing downstream can tell them apart                     |
| **D** | The CHAINED two-level arrival  | `epic → story → subtasks` compacted in one pass; both skipped ancestors as crumbs **in descent order**; the chain stops where the plan actually branches                                                                |
| **E** | The NEGATIVE cases             | E1 a multi-root level (≥2 nodes → the choice is the user's) and E2 a single **non-drillable** leaf (nothing beneath it → the lone card is _correct_) — both with **no breadcrumb at all** — plus the full descend table |
| **F** | Post-navigate-up resting state | after the user clicks the breadcrumb root (or Back), the single-parent level **sits still**; the re-descend table (refresh: no · explicit drill: yes · scope switch: yes)                                               |

### What "one node" counts — the level's WORK (MOTIR-1824, recorded after the build)

Panel E's descend table reads "2 or more nodes → NO", with the reason that decides it: _there is a
real branch; the choice is the user's._ The pinned **planning-origin cluster** (MOTIR-1013) is a node
on the root level of every project that ONBOARDED, and it is neither — it is provenance drawn beside
the road, not a branch in it. Counting it made an onboarded project's root level permanently
two-node, so the descent never fired there at all: exactly the projects the feature was for got the
lone card it exists to skip.

So the count the table describes is over the level's **work**, not its node array. A node the
consumer flags `decorative` (today only the origin cluster) still renders, selects, drags and
searches like any other — it is excluded from this ONE question. An off-level **ghost anchor** is
NOT decorative: it names a real, peekable work item, so it remains a reason to stop. Every other row
of the table is unchanged, and the treatment has no pixels of its own — an onboarded project simply
gets the arrival panel A already draws.

### Suppression is BEHAVIOUR, not chrome (panel F)

After an explicit navigation up, the resting level is an ordinary root level — the same one card,
the same drill chevron, no breadcrumb, no badge. Nothing marks the suppressed state, because
drawing one would tell the user about an internal flag they never set. The **refresh** control
(MOTIR-1540) must not re-descend either: it re-reads the CURRENT level, and re-descending would make
Refresh feel like it lost the user's place — the same in-place contract `roadmap-refresh.mock.html`
panel 2 already draws.

### Access path (DRAW THE DOOR — `run.md` design gate)

**No new door.** The surface is the shipped `/roadmap` route reached from the **Roadmap** primary
left-nav entry (MOTIR-1011), with the scope toggle (MOTIR-1382) selecting **Active sprint** — drawn
as a real rail + header in panel A, not merely named in prose. No new nav entry, no new route, no
new setting is proposed (per the parent story: this is an opinionated default with no knob).

### Token / a11y discipline (same rules as the canvas)

Colour via `--el-*` only (the breadcrumb is `--el-surface` on `--el-border` with
`--el-text-secondary` / `--el-text` crumb ink; the tints are the `--el-tint-*` set). Shape via
`--radius-card` / `--radius-control` / `--radius-badge` / `--height-control` / `--shadow-card` —
no Tier-0 `--color-*`, no raw `rounded-*`/`p-*`/`h-*`, no invented hue in any semantic surface (the
canvas dot-grid + the review-board backdrop are the sanctioned non-semantic decoration). The
breadcrumb keeps its shipped semantics: `<nav aria-label>` → `<ol>` → real `<button>` crumbs, the
last carrying `aria-current="page"`, and the `--focus-ring-color` focus-visible ring drawn in panel B.

---

## ⭐ The planning card DRILLS into the pre-plan stations (MOTIR-2204 / Story MOTIR-1755 — `planning-origin-drill.mock.html`)

The shipped `PlanningOriginCluster` (MOTIR-1013) says a project came from a planning journey — five
checked milestones and a **Complete** badge — and is wired to nothing. Meanwhile the journey's actual
output is fully built: four `DirectionDoc` kinds in the motir-ai pre-plan store (for MOTIR itself,
seeded by MOTIR-1354 / MOTIR-1357), a shipped modal viewer (`TierDocModal`) and a shipped full page
(`/direction/[tier]`), both from MOTIR-1355 — and `grep` finds `TierDocModal` and `StationNode`
mounted by exactly ONE surface, `components/onboarding/OnboardingCanvas.tsx`. **The destination
exists and the door does not**, which is what MOTIR-1762's roadmap check ("clicking one opens a real
document, not an empty tier") fails on.

### The model: two hops, both of them shipped canvas grammar

| Hop         | What the user does                                           | Whose interaction it is                                                                       |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **level 0** | select the phase card → the canvas's **Open ›** pill → drill | the roadmap canvas's own drill — what every epic beside it already does                       |
| **level 1** | select a station → the canvas's **View** button → the doc    | `detail-surfaces.mock.html` panel 3, verbatim — and the onboarding canvas's shipped behaviour |

Nothing about that is a new interaction, and the code card must not make it one. This sheet
**COMPOSES**: the canvas engine + layout (`roadmap.mock.html`, MOTIR-1009 / build MOTIR-1194), the
`StationCard` (`components/onboarding/StationNode.tsx`), `TierDocModal` (panel 4),
`/direction/[tier]` (panel 5) and `DirectionDocView` (MOTIR-834) are all shipped and are CITED here.
**No second doc viewer, no restyled `DirectionDocView`, no new direction route, and no click-to-open
on a card body** (`notes.html` #139). The phase card keeps its `360 × 124` box (`ORIGIN_W` /
`ORIGIN_H` unchanged), its fixed position, and its absence of a dependency edge into the epics.

> **This design replaces a first pass that made the cluster's five 28px tiles into individual doors**
> (Yue, 2026-08-05, mid-flight). The drill model is strictly better: it reuses two shipped
> interactions instead of inventing a third, it dissolves the 28px-affordance problem rather than
> solving it, and — see the keyboard section — it removes an entire class of event-handling bug the
> in-card affordance would have had to defend against.

### DECISION 1 — the drilled level shows FOUR of the six stations

`STATION_ORDER` is the four `DirectionDocKind` tiers plus `design` and `plan`. Every station has an
explicit disposition; none is left for the code card to infer.

| `STATION_ORDER`   | On the level? | Why                                                                                                                                                                |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`discovery`**   | **yes**       | Holds a `DirectionDoc`. Openable when produced; the shipped `upcoming` face when not.                                                                              |
| **`vision`**      | **yes**       | Same. Its `FeatureCatalogView` folds into the doc, exactly as it already does in the modal.                                                                        |
| **`feasibility`** | **yes**       | Same. Optional tier — keeps its shipped **can skip** tag while unproduced.                                                                                         |
| **`validation`**  | **yes**       | Same.                                                                                                                                                              |
| **`design`**      | **no**        | Holds no document. Its card exists to carry a CTA into the LIVE onboarding design step (MOTIR-1040); a finished project changes its look in Settings → Appearance. |
| **`plan`**        | **no**        | Holds no document. Its card previews the work-item tree — which is the level the user just drilled OUT of, one Back away.                                          |

Neither omitted station could be openable, and a station you cannot open, on a level whose whole
purpose is opening things, is noise.

### DECISION 2 — the phase card is ALWAYS drillable; only the badge waits on data

Drilling is what reveals whether documents exist, so drillability needs no read at level 0. That
matters twice: it keeps the entry affordance honest (there is always something behind it — see the
empty level below), and it keeps the pre-plan read off the roadmap's first paint entirely. The read
happens **on drill**, inside the canvas's own per-level load, which already has a spinner. The
**only** thing level 0 needs the produced set for is the badge — so the card paints its chip-less
state immediately and upgrades when the read lands. It can never claim "Complete" before it knows.
(This is the MOTIR-2069 streaming lesson, and the drill model largely dissolves it.)

### What the phase card is allowed to ASSERT (panel D)

`showPlanningOrigin` is `ctx.project.onboardingRanAt != null` and nothing else, so today **every**
onboarded project renders the mint **Complete** badge and five done checks — including one whose
journey wrote no document at all. The marker stays the gate on WHETHER the card renders (MOTIR-1264's
contract); what it ASSERTS follows the produced set.

| State                   | Condition                         | Phase-card chip                              | Station level                                     |
| ----------------------- | --------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| **A · all four**        | 4 kinds produced (the MOTIR case) | mint `Complete` + check — shipped, unchanged | four full station cards, each openable (panel B)  |
| **B · partial**         | 1–3 kinds produced                | neutral `{n} of 4 docs`                      | produced stations openable, the rest `upcoming`   |
| **C · none**            | marker set, 0 produced            | neutral `No docs`                            | four `upcoming` stations, none openable (panel E) |
| · pending / failed read | read in flight, or motir-ai down  | **no chip at all**                           | the level's own shipped spinner, then state C     |
| **D · sprint scope**    | `scope === 'sprint'`              | —                                            | the card is not rendered at all — **shipped**     |

**Why the unconditional "Complete" is wrong.** The badge is a claim about the journey's _output_, but
its only evidence is a marker that records the journey _ran_ — so on a project whose pre-plan wrote
nothing it asserts four documents that do not exist. **It is still not an error state:** `Idea` and
`Plan` keep their checks (the marker is set on first plan approve/materialize, so it genuinely
attests both), the strip still reads as provenance, and a neutral chip reports a fact instead of
flagging a fault. The chip keeps the **verdict** only in state A, where every implied artifact
exists, and otherwise reports the **count** — the fact the card can actually prove.

Row **D** is recorded for completeness only: `WorkItemRoadmap.tsx` already gates the cluster with
`includeOrigin: parentId === null && showPlanningOrigin && scope !== 'sprint'`.

### The station level, produced and not (panels B · E)

Both faces are **shipped `StationCard` states**, not new treatments. A produced tier is the full card
— tier tile + per-tier accent from `TIER_META`, plain-language title, captured-findings rows, the
mint **Reviewed** pill — and is `viewable: true`, so selecting it reveals **View**. A tier that
produced nothing renders the shipped `upcoming` face (`border-(--el-border-soft) bg-(--el-surface)
opacity-80`, footer omitted, **can skip** tag on the optional tiers) and is **not** `viewable`, so
selecting it reveals no View button at all — panel 3's _only PRODUCED tiers carry it_, enforced by
the same `StationView.openable` flag the onboarding canvas already uses. **No dashed or dotted
border** is introduced: the distinction is the absent findings, the absent pill and the softened
card, none of which collides with the `data-style` shape axis.

Stations are joined by the canvas's `kind: 'flow'` edges — drawn as sequence, and deliberately NOT
counted toward the Dependencies legend (`ProjectCanvasDep`).

**A drill into a journey that produced nothing still lands somewhere worth being** (panel E): four
`upcoming` stations naming the journey's shape, none of them openable. No empty-state illustration,
no error, no new component — and a motir-ai failure on the pre-plan read lands here too, never on an
error page.

### The destination — named, and NOT redrawn (panel C)

A station's **View** opens **`TierDocModal` with `origin="roadmap"`** — the same modal
`OnboardingCanvas` already mounts and the same one `detail-surfaces.mock.html` **panel 4** specifies;
its loading / error / empty(no-doc) states and its `DirectionDocView` body are shipped behaviour this
design does not touch. The modal head already carries **Open full page** → `/direction/[tier]`
(**panel 5**), so the roadmap never links the full page directly.

### The keyboard path (panel F) — and why it is the affordance argument

Because both hops use the canvas's OWN action slot rather than a control drawn inside a card, the
keyboard path is the one the canvas already ships and **this design adds no key handling at all**:
**Tab ①** the node wrapper (`tabIndex={0}`, the canvas's `outline --el-accent` ring; Enter/Space
selects), **Tab ②** onto **Open ›** → Enter drills (breadcrumb + Back appear), **Tab ③** through the
stations → Enter selects, **Tab ④** onto **View** → Enter opens the modal; Esc returns focus to the
station.

That is not just an accessibility note — it is the reason this shape beats an in-card affordance. A
control drawn INSIDE a canvas card has to fight the wrapper: its keydown bubbles into a handler that
calls `preventDefault()`, which cancels a nested button's implicit click, and a press on it has to
`stopPropagation` to escape the canvas's drag/select gesture. Routing both hops through the canvas's
own action slot means none of that exists to get wrong, and `notes.html` **#139** (a bare click on a
canvas card only ever selects) holds by construction rather than by care.

### Required code deltas (what MOTIR-2205 must implement)

| Change                                                                                                                                                         | Where                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Origin node gains `drillable: true` + a `crumbLabel`. **`decorative: true` STAYS**                                                                             | `components/planning/workItemLevel.tsx`                       |
| `loadLevel` intercepts `parentId === ORIGIN_ID` and returns the synthetic station level — no `fetchRoadmapLevel` call; stations joined by `kind: 'flow'` edges | `components/planning/WorkItemRoadmap.tsx`                     |
| `onView` branches: a tier-station id → `setOpenTier(kind)`, anything else → the existing `useWorkItemQuickView` peek. Mount `TierDocModal origin="roadmap"`    | same — copied from `OnboardingCanvas.tsx`                     |
| `StationCard`'s `session` prop becomes **optional** (see below)                                                                                                | `components/onboarding/StationNode.tsx`                       |
| The phase-card chip takes the produced set, resolved LATE — never awaited ahead of the canvas                                                                  | `app/(authed)/roadmap/page.tsx` → `PlanningOriginCluster.tsx` |

> **⚠️ `decorative: true` must survive.** `ProjectRoadmapCanvas`'s auto-descend counts
> `lvl.nodes.filter((n) => n.decorative !== true)` — the MOTIR-1824 rule that provenance drawn beside
> the road is not a branch in it. Drillable and decorative are independent axes; making the card
> drillable must not make it a branch, or an onboarded single-epic project stops auto-descending
> exactly as it did before that bug was fixed.

> **⚠️ `StationCard.session` is required today and the roadmap has no `DiscoverySession`.** The prop
> is read in exactly two places: the `design` station's `designChoice` (not on this level at all) and
> the classification/platform FALLBACK in `CapturedFindings` when a doc carries no structured
> `summary`. `PreplanStateDTO` does return a `session`, so pass it when present — the card must simply
> stop _requiring_ it. Relax it additively and assert the onboarding canvas's render is unchanged.

### Exact copy (the strings the frontend ships — `messages/en.json` + `zh.json`)

`roadmap.canvas.origin.*` keeps `planning` / `complete` / `idea` / `discover` / `shape` / `validate`
/ `plan` unchanged and gains three keys (both catalogs — the zh parity gate):

| Key         | en                  | zh                        |
| ----------- | ------------------- | ------------------------- |
| `noDocs`    | `No docs`           | `暂无文档`                |
| `docsCount` | `{count} of 4 docs` | `4 份文档中的 {count} 份` |
| `crumb`     | `Planning`          | `规划`                    |

The station titles and subtitles are the onboarding catalog's existing
`onboarding.chat.canvas.stations.*` and `TIER_META` labels — reused, not duplicated.

### Access path (DRAW THE DOOR — `run.md` design gate)

**No new route and no new nav entry.** The surface is the shipped `/roadmap` page reached from the
**Roadmap** primary left-nav entry (MOTIR-1011) with the scope toggle on **Whole project** — drawn in
panel A as a real rail + header, not named in prose. The new door is the **Open ›** pill on the
selected phase card, drawn in place; the second door is the **View** button on a selected station,
drawn in panel B.

### Token / a11y discipline (same rules as the canvas)

Every value in `planning-origin-drill.mock.html` is GENERATED from
`packages/design-system/theme.css` (the `@theme` Tier-0 block, the `:root, [data-appearance-scope]`
Tier-3 block and both `[data-theme='dark']` blocks) and every glyph from `lucide-react`'s
`__iconNode` — no retyped hex, no drawn path, no invented colour, and the dark export is a real token
flip rather than a copy of the light one. Colour via `--el-*` only (the station tiles take their own
`--el-station-tier-*` tokens, per MOTIR-1277); shape via `--radius-card` / `--radius-control` /
`--radius-badge` / `--radius-btn` / `--spacing-chip-x/y` / `--spacing-btn-x/y` / `--shadow-subtle` /
`--shadow-card` — no Tier-0 `--color-*`, no raw `rounded-*`/`p-*`/`h-*`, and the canvas dot-grid +
review-board backdrop remain the only sanctioned non-semantic decoration. Semantics are the canvas's
shipped ones: the node wrapper is the `tabIndex={0}` focus target, **Open ›** / **View** are real
`<button>`s with `aria-label`s, and the breadcrumb keeps `<nav aria-label>` → `<ol>` → real crumb
buttons with `aria-current="page"` on the last.

---

## Deliverable

Eleven three-file surfaces under `design/roadmap/`, sharing this `design-notes.md`:

- **Canvas** — `roadmap.mock.html` + `roadmap.png` (MOTIR-1009).
- **Detail surfaces** — `detail-surfaces.mock.html` + `detail-surfaces.png`
  (MOTIR-1351).
- **Scope toggle** — `scope-toggle.mock.html` + `scope-toggle.png` (MOTIR-1380).
- **Ready highlight** — `ready-highlight.mock.html` + `ready-highlight.png`
  (MOTIR-1416).
- **Full-screen** — `full-screen.mock.html` + `full-screen.png` (MOTIR-1423).
- **Locate control** — `locate.mock.html` + `locate.png` (MOTIR-1427).
- **Done & ready styles** — `done-ready.mock.html` + `done-ready.png` (MOTIR-1434).
- **Refresh control + URL scope** — `roadmap-refresh.mock.html` +
  `roadmap-refresh.png` (MOTIR-1540).
- **Work-type: manual/human node** — `node-worktype.mock.html` +
  `node-worktype.png` (MOTIR-1641 / 8.8.35).
- **Auto-descended arrival state** — `auto-drill.mock.html` + `auto-drill.png`
  (MOTIR-1805 / Story MOTIR-1803).
- **Planning card drills into the pre-plan stations** —
  `planning-origin-drill.mock.html` + `planning-origin-drill.png` +
  `planning-origin-drill.dark.png` (MOTIR-2204 / Story MOTIR-1755).
- **The root level's non-epic rows** — `root-non-epic-rows.mock.html` +
  `root-non-epic-rows.png` (MOTIR-3493, unblocking bug MOTIR-3490).

## ⭐ The ROOT level's NON-EPIC rows (MOTIR-3493 — `root-non-epic-rows.mock.html`)

The card this unblocks is **MOTIR-3490**, and it has two halves that look like one:
a parentless `bug` draws on the road beside the epics, and the level read is
capped at 200 rows sorted by key ascending, so overflow silently discards the
**newest epics**. They are independent — grouping happens after the read, so it
relieves none of the pressure on the cap — and this sheet answers both.

**What the root level is today, measured not assumed.** `findProjectTreeLevel`
builds its root predicate as `w."parentId" IS NULL` and nothing else — there is no
kind predicate anywhere on that path — so every legal root draws. Only `subtask`
is refused a root position (`prisma/sql/work_item_triggers.sql`), which leaves
`epic | story | task | bug` all eligible. This spec's own §507 line, _"the full
root level (every epic)"_, describes an assumption the code has never enforced.

**Rendered before drawn.** Sheet 1 is the shipped `WorkItemNode` at
`origin/main` 9b504a47, rendered from its own source with the real theme, not a
stylised stand-in — and it changes the framing. A parentless bug that is READY
takes the whole-card `--el-tint-mint` wash (MOTIR-1422), so the defect is not
"a bug appears between two epics": on the opening canvas it is the **most
prominent node on the road**.

The seven decisions below are each a choice the code card would otherwise make
silently. Every one has a disposition; none is left to be inferred.

### DECISION 1 — the predicate is `parentId === null && kind !== 'epic'`

MOTIR-3490 contradicts itself here, which is why this is decision one: its first
acceptance criterion says the root draws no **`bug`** node beside the epics, while
its fix direction says collapse every **non-`epic`** row into a _"Defects"_ node.
Those group different sets.

| root kind | grouped? | why                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------- |
| `epic`    | **no**   | The road IS the epics. This is the level's whole subject.                                         |
| `bug`     | **yes**  | The case the card was filed for.                                                                  |
| `task`    | **yes**  | A parentless task is on the road for the same reason a bug is — nobody put it under an epic.      |
| `story`   | **yes**  | Same. A story with no epic is not a stop on the road; it is work that has not been placed on one. |

**The predicate is on the KIND, not on the defect-ness**, because a bug-only rule
leaves the story and task cases unhandled and re-opens this same defect the first
time somebody files a parentless story. A rule that is total over the four legal
root kinds cannot be outlived that way.

**And the second conjunct is load-bearing — see decision 6.** `parentId === null`
is what separates a row that is a root **of the tree** from one that is a root only
because the sprint view re-rooted it.

### DECISION 2 — the node's NAME is "Not in an epic", not "Defects"

Rejected: **"Defects"**. It is false the moment a parentless `story` or `task`
joins the group, and under decision 1 that is a normal state rather than an edge
case. A label that has to be re-read every time the membership changes is a label
that will eventually lie.

**"Not in an epic"** states the one property every member shares, in the reader's
words, and needs no vocabulary the product does not already have. It is also the
crumb label (decision 4), so the door and the room say the same thing.

### DECISION 3 — the card FACE is the shipped `WorkItemNode` box, minus three slots

Rejected in turn: `GhostAnchor` (dashed red — it means _broken dependency_, and
this is not a problem); `StationCard` (the pre-plan journey's language, a
different domain); the wide plan-preview cluster (a summary of a whole tree, at
360px — it would out-shout the epics it stands beside).

So: the **same box** — `NODE_W × NODE_H`, `--radius-card`, `--el-border`,
`--el-surface`, `--shadow-card` — with three substitutions, drawn slot by slot in
sheet 6:

- the **kind tile** loses its `--el-type-*` hue for a neutral `--el-muted` tile
  carrying a `layers` glyph in `--el-text-secondary`. No kind backs this node, and
  borrowing a kind's hue would say it IS that kind;
- the **identifier** slot carries the **count** (`7 items`) in the same mono type.
  It is what identifies the node, and there is no key to put there;
- the **status pill** slot is **empty**, and the **progress meter** is **absent**.

Those last two are the decision worth stating out loud. They are the two places a
synthetic node is most tempted to say something — _"Mixed"_, _"7 open"_, a
done/total bar — and each would be a claim about work the node does not own. The
meter in particular means _"this container's own work is N% done"_, and the group
is a drawer, not a unit of work: its members are unrelated to one another.

### DECISION 4 — the drilled level is served from the read the canvas ALREADY made

The members are in the root read already; grouping only decided where to draw
them. So `loadLevel` intercepts the group's id and serves them from the cached
level — **the same shape `ORIGIN_ID` already uses** for the pre-plan station
level, and for the same reason: no work item backs the node, so asking the API
for its children would ask for the children of an id it has never heard of.

- **No second fetch, no new endpoint, no new wire field** — `RoadmapLevelItem`
  already carries `kind` and `parentId`.
- **Crumb label: "Not in an epic"** — supplied by the consumer as localized copy,
  exactly as `originCrumbLabel` is.
- **Each member renders unchanged** (sheet 3): its own status chip, kind tile,
  ready wash, drill chevron where it has children, and the quick-view peek on
  select. MOTIR-3490's second acceptance criterion is satisfied by reuse, not by
  a new treatment.
- **No empty state exists to draw.** The group node is emitted only when the
  partition is non-empty, so the level it opens can never be empty. Recorded
  because the absence of an empty state is otherwise indistinguishable from a
  forgotten one.
  - **⚠️ THAT SENTENCE IS ABOUT THE NODE'S EMISSION, NOT ABOUT THE LEVEL — and
    "SERVED FROM the root read" does not mean "SERVED FROM whatever is in the
    cache" (bug MOTIR-4426, added after the fact).** The node is built from a
    level that was just read, so it cannot be emitted over an empty partition;
    the LEVEL BEHIND IT is built from a cache ENTRY, and an entry can be gone.
    The manual refresh (MOTIR-1542) clears every cached level, so a reader
    standing INSIDE the group got a miss — and each `?? []` on the way out turned
    that miss into a well-formed EMPTY level, which drew `emptyDrilled` ("This
    node has no children to show") over rows that exist.
  - **So a MISS RE-READS the root level; it never renders empty.** A HIT is
    unchanged and still issues no request, which is what keeps the no-second-fetch
    bullet above true for the ordinary drill — the guarantee is about a DRILL
    within one refresh generation, not about the level having no source of its
    own. The ORIGIN door already worked this way and is the precedent: its
    `readPreplan` promise is keyed on the refresh generation, so a refresh makes
    it re-read rather than come back empty.
  - **The pattern, for the next synthetic level anyone adds here:** a door whose
    contents are DERIVED from another level owes a way to re-derive them. Serving
    them from a cache is an optimisation; being unable to re-read is a defect, and
    it presents as an empty room rather than as an error.
- **⚠️ THE LEVEL'S EDGES ARE SCOPED TO ITS MEMBERS, and "served from the cached
  level" does NOT mean "handed the cached level" (bug MOTIR-3557, added after the
  fact).** The bullets above settle what a MEMBER renders and were read as
  settling the level; they are silent on the level's own EDGE set, and the code
  card resolved that silence by passing the root read's edges through whole.
  **A level draws the edges whose BLOCKED end is one of ITS rows** — the same
  predicate `findBlockedByEdges` applies (`fromId IN (level rows)`) when the
  server reads a real level, applied here because this one is synthetic. Sheet 3
  is already drawn this way: the members, no anchors, no red edges.
  - **An edge that LEAVES the group** — a grouped row blocking an epic still on
    the road — belongs to the ROOT level, which is where its blocked end is, and
    it keeps its ghost anchor there (named from the grouped row, which is in
    hand). It draws nothing on the grouped level.
  - **An edge WHOLLY INSIDE the group** draws as an ordinary within-level arrow
    on the grouped level, and nothing at the root.
  - **An edge between two rows that are BOTH off the level draws nothing at all.**
    Un-scoped, the root's epic→epic chain — nineteen edges over twelve distinct
    blockers on Motir's own tree — reappeared behind this door as twelve
    ANONYMOUS ghost anchors (`—` over the "Blocked across stories" fallback,
    because a root epic is ON the root level and so is never in
    `offLevelBlockers` to be named from), chained to one another. Twelve red
    warnings, in the canvas's loudest vocabulary, about the healthiest part of
    the tree.

### DECISION 5 — it is NOT `decorative`

`decorative` means _not a member of the level's work_, and its one effect is to be
excluded from the count `autoDescendSingleParent` uses to ask whether a level
offers the reader a **choice**. The planning-origin card is decorative because it
is provenance drawn beside the road. This node is not: it holds real work, and
drilling it is a real choice.

**The cost, stated rather than discovered.** A single-epic project that acquires
its first parentless row stops auto-descending — its root level now has two
choices. That is correct, and it is the same verdict panel E already records for
the negative case (_≥2 nodes → the choice is the user's_). Marking it decorative
would auto-descend the reader **past** the group into the epic, hiding the
unparented work on arrival — which is the silence this whole card exists to end.

### DECISION 6 — SPRINT scope, and why the obvious rule is wrong there

Sprint scope re-roots the level at the **topmost in-sprint members** — usually
stories and subtasks, since their epic ancestors are not themselves committed. A
`kind !== 'epic'` rule alone would therefore sweep nearly the whole sprint into
one node.

`parentId === null` is what keeps the two apart (sheet 5):

- a **committed parentless defect** has no parent, so it groups — MOTIR-3490's
  fifth acceptance criterion, satisfied;
- a **committed member story** has an epic parent and is a root only of the sprint
  VIEW, so it stays on the road. It is the sprint's actual work.

In project scope the two conjuncts pick out the same set, so nothing changes
there. The wire already carries `parentId`, so telling them apart costs nothing.

### DECISION 7 — the truncated level says so, at EVERY level

The cap is the sharper half of MOTIR-3490 and it is **not** addressed by anything
above: `TREE_LEVEL_MAX_TAKE` is applied by the level read, before grouping can see
a row. Today a level simply stops at 200, ordered by key ascending, so the rows it
drops are the highest keys — the **most recently created epics** — with no cursor,
no affordance and no error.

**A truncated level draws a `+ N more` tile in its last cell** (sheet 4):
`WorkItemNode`-sized, a dashed `--el-border-strong` edge on `--el-surface-soft`,
reading `+ 47 more` over `Showing 200 of 247`, with a **Show all** action that
re-reads the level unbounded.

- **It is not a door.** A drill chevron would say there is a level behind it;
  there is not — there is more of _this_ level.
- **At every level, not only the root.** The cap is per-level, so an epic with 300
  stories has the same silence.
- **The number needs no cursor.** `countProjectTreeLevel` already exists beside
  the level read, so this is one field on the level DTO, not a paging protocol.
- **The sort is NOT changed.** Re-ordering the root read so the newest epics
  survive would silently reorder the road for every project, to fix an overflow
  almost none of them have. The tile makes the loss visible and Show all makes it
  recoverable; that is enough, and it is less invasive.

**The dashed edge is borrowed on purpose.** The onboarding init screen's
plan-preview cluster already ends its epic strip with a dashed
`+ N more epics` tile, so the canvas has a vocabulary for _there is more of this
than is drawn_. The difference is `Show all`: that tile caps a preview
deliberately, this one reports an overflow the reader must be able to escape.

### The ACCESS PATH, and where the node sits

The grouped node **is** the door to the unparented work, so both halves are drawn:
the root canvas with the node among the epics (sheet 2) and the level behind it
with its breadcrumb and Back (sheet 3).

**Its position needs no code.** `deterministicLayout` already drops a node that
takes part in no dependency edge into a separate band **below** the flow — its own
comment names the case, _"a standalone bug"_. The group node has no edges, so it
lands in that band by the shipped rule, and unlike the pinned planning-origin
cluster it carries **no explicit `x` / `y`** and overrides nothing.

### What this sheet does NOT decide

The code card owns where the partition happens (`buildWorkItemLevel` is the
obvious seat, since it already receives the level and builds the origin node
beside it) and what the group node's synthetic id is. Those are build choices with
no reader-visible consequence, and pinning them here would only invite the two
files to drift.

---

All rendered with Playwright chromium — full-page, light theme,
`deviceScaleFactor: 2`, ~1200px wide; `prettier --check` clean. (The
planning-origin-drill surface also carries a `.dark.png`, rendered from the real
`[data-theme='dark']` token blocks, so the station cards' per-tier tints are
checked in both.)

---

## The streaming allocation at ARRIVAL — `/roadmap` (MOTIR-3442)

Part of [MOTIR-3440](motir:cmt8s085i003li1ph06u469kx)'s sweep of the 24 heavy authed surfaces. The
rule this applies is `design/shell/design-notes.md` § _The navigation-pending grammar_ →
_WHICH SURFACES EARN A FRAME_, and the three-tier method is
`design/work-items/design-notes.md` § _The item page at ARRIVAL_'s. **Neither is restated here.**
Measured against `origin/main` `9455fc3c`.

|                            |                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `getSession` → `getTranslations('roadmap')` → `getActiveProject` → `projectAccessService.getCapabilities` (`canBrowse` — a refusal renders `NoAccessState`) → `workItemsService.getProjectRoadmap(projectId, null)`, whose **only** use is `roots.nodes.length === 0`: it selects the empty state |
| **with the frame**         | the `<h1>` and the `subtitle` — `t('heading')` and `t('subtitle', { project })`, both resolved by the gate                                                                                                                                                                                        |
| **with the first content** | — **nothing.** `RoadmapView` receives no level data at all; it is a client canvas that fetches its own                                                                                                                                                                                            |
| **after the page**         | — nothing from the server                                                                                                                                                                                                                                                                         |
| **settles**                | **once.** The canvas's own subsequent level fetches are its own pending state, not the page's                                                                                                                                                                                                     |
| **verdict**                | **NONE.** Not a preference — there is no server-side region left to cover. Rule 2 asks what has nothing to show yet, and by the time the page function returns, everything it renders is either painted or client-owned                                                                           |

**What this surface actually owes the story is a concurrency change, not a frame.**
`getProjectRoadmap` and `sprintsService.getActiveSprint` are **independent and currently serial** —
the sprint read is issued after the empty-state branch and feeds only `hasActiveSprint` /
`sprintName` / `sprintGoal`. One `Promise.all` collapses two round trips into one. Nothing else on
this page is serial.

> ## ⚠️ AMENDMENT — 2026-08-26, MOTIR-3445. THE CONCURRENCY CHANGE IS REFUSED, AND THE PAGE GETS NO DIFF.
>
> The paragraph above says this surface _"owes the story a concurrency change, not a frame"_:
> `getProjectRoadmap` and `sprintsService.getActiveSprint` are independent and serial, so one
> `Promise.all` collapses two round trips into one. That is true, it was built, and it is **wrong to
> ship** — which the build discovered by running the page's own guard file.
>
> **The page returns early for an EMPTY roadmap, before the sprint read.** So today a first-run
> project pays one read; the concurrent version makes it pay two.
> `tests/planning/roadmapPageStreaming.test.tsx` asserts exactly that
> (`expect(getActiveSprint).not.toHaveBeenCalled(); // the empty branch returns early`), and it
> exists because _"`/roadmap` already pays two reads before it paints, and MOTIR-2069 is the record
> of what a third one costs on a flagship surface."_
>
> **The empty branch is the ONBOARDING path** — the reader with the least reason to wait and the
> least patience for it. A round trip saved on populated projects does not pay for one added to
> every empty one, on the one surface carrying a guard file that says so.
>
> The entry's own reasoning was sound and its ARITHMETIC skipped the branch: two independent reads
> are not two unconditional reads. **`/roadmap` ships no diff in MOTIR-3445**, and its serial pair
> is correct as it stands.

**The canvas's own pending state is REUSED, not redrawn.** `ProjectRoadmapCanvas` owns what it shows
while a level is in flight; this asset adds nothing to it and the code card must not either.

**A route boundary is declined, and here it is a preference rather than a prohibition** —
`/roadmap` does not call `notFound()`. Rule 5 applies: one mechanism, not two.

---

## ⭐ The roadmap you come back to (MOTIR-3834 / Story MOTIR-3833 — `roadmap-arrival.mock.html`)

`roadmap-arrival.mock.html` specifies FOUR refinements to the shipped `/roadmap` surface as ONE
surface, because they all move the same chrome: the **level-addressable URL**, the **full-fold canvas
frame**, the **collapsible Dependencies panel**, and the **ARRIVAL VIEW** a level is first drawn at.
Like the scope toggle (MOTIR-1380) and the refresh control (MOTIR-1540), its mandate is to **COMPOSE
the shipped header + canvas, not redraw them**: `ProjectRoadmapCanvas` (MOTIR-1194) over the
`PlanningCanvas` engine (MOTIR-1236) is reused unchanged, its look is owned by
`design/roadmap/roadmap.mock.html`, and its edge vocabulary by `design/roadmap/edges.mock.html`.

**Every canvas, node card, legend and page header in the asset is the app's own rendered markup**,
dumped from the real components and laid out by the shipped `deterministicLayout` — not a redraw
(the design-against-shipped-reality gate). **Every number below is measured in Chromium**, and the
harness that produced them is reproduced inline at the end of this section.

### Composed components + their contracts (notes #95)

| Composed thing         | Source                                                                             | Contract this design honours                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the canvas + its nodes | `ProjectRoadmapCanvas` / `WorkItemNode` (MOTIR-1194)                               | reused UNCHANGED. Every new prop is opt-in and defaults to today's behaviour — the component has four other consumers                                                            |
| the arrival geometry   | `fitView` / `centerOn` (`lib/planning/canvasGeometry.ts`)                          | the arrival composes the two functions already there; no third transform, and `MIN_SCALE = 0.3` is untouched                                                                     |
| the focal ladder       | the LOCATE control's own priority (`ProjectRoadmapCanvas.tsx`, `locateActionable`) | `here` → first `ready` → the level's first node. The canvas gains no second notion of "the node that matters"                                                                    |
| the edge legend        | the legend overlay (MOTIR-1331), heading `roadmap.canvas.legend.heading`           | reused; the collapse adds a chevron to its existing heading row and changes nothing else                                                                                         |
| the page header        | `components/planning/RoadmapView.tsx`                                              | reused unchanged. The full-fold change is to the CANVAS BOX's `calc()` and its bottom margin — the header is not re-laid-out                                                     |
| the shell's band       | `--shell-bottom-clearance` (MOTIR-2763, `app/(authed)/layout.tsx`)                 | the canvas SPENDS the band, and the bottom-RIGHT overlay is lifted by the same custom property — never by a copied `96px`, so a workspace without the orb gets its `1.5rem` back |
| the client preference  | `lib/hooks/useAttachmentsView.ts`                                                  | the collapse state uses that exact pattern — `useSyncExternalStore` + a module-cached snapshot + a `motir.*` key, whose server snapshot is today's behaviour                     |
| the access path        | the **Roadmap** primary left-nav entry (MOTIR-1011)                                | unchanged. No new route, no new nav affordance; the one new door is the collapse control, whose entrance is the panel itself                                                     |

### The six panels (`roadmap-arrival.mock.html`)

| Panel | What it draws                                                                                                                                     | Composes, does not redesign                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **0** | the ACCESS PATH — the shipped rail with **Roadmap** `aria-current="page"`, and the one new affordance at real size in both states                 | `app/(authed)/_components/SidebarNav.tsx` + `components/ui/Sidebar.tsx`'s item |
| **1** | the FULL-FOLD frame at 1440×900 with the vertical budget annotated, the orb and its 76 px reach drawn in, and a 1:1 today-vs-proposed bottom band | `components/planning/RoadmapView.tsx` + `app/(authed)/layout.tsx`              |
| **2** | the ARRIVAL VIEW — the measured legibility table, then the root level today vs. at the floor, and a small level that is unchanged                 | `ProjectRoadmapCanvas` + `lib/planning/canvasGeometry.ts`                      |
| **3** | the Dependencies panel COLLAPSED and EXPANDED, at real size, in place, in both the project-scope and sprint-scope variants                        | the shipped legend overlay (MOTIR-1331 / MOTIR-1379)                           |
| **4** | the URL states — three address bars and the behaviour spec (no new pixels)                                                                        | the `?scope=` precedent, `roadmap-refresh.mock.html` panel 4                   |
| **5** | what does NOT change                                                                                                                              | —                                                                              |

### 1. The full-fold frame — the vertical budget, MEASURED

The chrome above the canvas box is **160 px = 10rem**: the top nav `h-14` (56) + the shell's `pt-6`
(24) + the page header (56 — the `font-serif text-2xl` `h1` at 32, `gap-1` 4, the `text-sm` subtitle 20) + the stack's `gap-6` (24). The shipped box subtracts **11.5rem**, which is **24 px more than the
chrome actually costs**, and then subtracts `--shell-bottom-clearance` a SECOND time — the shell has
already spent that band as `pb-(--shell-bottom-clearance)`.

| viewport (window) | usable | canvas today | dead band below  | canvas proposed | dead band | gain     |
| ----------------- | ------ | ------------ | ---------------- | --------------- | --------- | -------- |
| 1366×768          | 648    | 1062×448     | 40 **+ scrolls** | 1062×488        | 0         | **+40**  |
| 1440×900          | 780    | 1136×500     | 120              | 1136×620        | 0         | **+120** |
| 1512×982          | 862    | 1208×582     | 120              | 1208×702        | 0         | **+120** |
| 1920×1080         | 960    | 1616×680     | 120              | 1616×800        | 0         | **+120** |

"usable" is the window height minus ~120 px of browser chrome. **At 1366×768 the shipped
`min-h-[28rem]` floor exceeds the computed height, so `/roadmap` SCROLLS today** — on the one
signed-in surface whose shell is `h-dvh overflow-hidden` — **and the Reset-layout button already
overlaps the Plan-with-AI orb by 19 px there.**

**THE SPEC — the canvas TAKES the band:**

```css
height: calc(100dvh - 10rem);
margin-bottom: calc(-1 * var(--shell-bottom-clearance));
```

`min-h-[28rem]` stays; at 1366×768 the computed height becomes 488, so the floor no longer binds.

**Only the bottom-RIGHT overlay moves.** The orb is `fixed right-5 bottom-5`, 56 px square — a 76 px
reach from both edges — so it can only meet an overlay anchored bottom-right. Measured positions,
all four viewports:

| overlay            | shipped anchor                     | with the canvas at the fold                                  | orb clearance |
| ------------------ | ---------------------------------- | ------------------------------------------------------------ | ------------- |
| zoom cluster       | `bottom-4 left-4` (PlanningCanvas) | unchanged                                                    | n/a (left)    |
| LOCATE             | `bottom-4 left-[8.25rem]`          | unchanged                                                    | n/a (left)    |
| Dependencies panel | `bottom-[4.25rem] left-3`          | unchanged, collapsed or not                                  | n/a (left)    |
| **Reset layout**   | `right-3 bottom-4`                 | `bottom: calc(1rem + var(--shell-bottom-clearance, 1.5rem))` | **37 px**     |

Expressed in the shell's own custom property, never a copied `96px`: a workspace with AI planning
unconfigured sets it to `1.5rem` and the control comes back down.

### 2. The ARRIVAL VIEW — the legibility FLOOR is **0.80**, and it is derived

`PlanningCanvas` remounts per drill level (`key={`level:${focusId}`}`) and `fitView`s the WHOLE level
once. On the project root — eighteen epics, a **1000×1324** world box under the shipped 3-column
`deterministicLayout` at `NODE_W`×`NODE_H` = 280×124 — that is a correct fit and an unreadable one.

The real `WorkItemNode` rendered in Chromium at `deviceScaleFactor: 1` and read. Type sizes are the
card's own multiplied by the scale: identifier `font-mono text-xs` (12), title `text-sm` (14), status
chip `text-[11px]`.

| scale    | card px | identifier | title    | status chip | read at 1×                                             |
| -------- | ------- | ---------- | -------- | ----------- | ------------------------------------------------------ |
| 1        | 280×124 | 12         | 14       | 11          | legible — the authored size                            |
| 0.90     | 252×112 | 10.8       | 12.6     | 9.9         | legible                                                |
| 0.85     | 238×105 | 10.2       | 11.9     | 9.35        | legible                                                |
| **0.80** | 224×99  | **9.6**    | **11.2** | **8.8**     | **THE FLOOR** — all three still resolve                |
| 0.75     | 210×93  | 9          | 10.5     | 8.25        | marginal — the title reads, the chip is at the limit   |
| 0.70     | 196×87  | 8.4        | 9.8      | 7.7         | the identifier blurs                                   |
| 0.65     | 182×81  | 7.8        | 9.1      | 7.15        | the identifier is illegible                            |
| 0.60     | 168×74  | 7.2        | 8.4      | 6.6         | the title starts to smear                              |
| 0.55     | 154×68  | 6.6        | 7.7      | 6.05        | nothing but the fill reads                             |
| 0.50     | 140×62  | 6          | 7        | 5.5         | nothing but the fill reads                             |
| 0.45     | 126×56  | 5.4        | 6.3      | 4.95        | nothing but the fill reads                             |
| 0.40     | 112×50  | 4.8        | 5.6      | 4.4         | today's arrival on a wide display                      |
| 0.35     | 98×43   | 4.2        | 4.9      | 3.85        | colour blocks only                                     |
| 0.30     | 84×37   | 3.6        | 4.2      | 3.3         | `MIN_SCALE` — today's arrival at 1366×768 and 1440×900 |

**The floor is 0.80 because it is DERIVED, not chosen.** The card's smallest authored type size is
the 11 px status chip, so the rule is: **the TITLE never renders smaller than the smallest type the
card itself authors.** 14 × s ≥ 11 ⟹ s ≥ 0.786, rounded up to a clean **0.80**. The code card takes
this number; it does not re-derive it.

What the root level actually arrives at, per viewport (`fitView(bounds, canvasBox)` on the measured
box):

| viewport  | root arrival today  | root arrival at the full fold | the floor | a 5-node level |
| --------- | ------------------- | ----------------------------- | --------- | -------------- |
| 1366×768  | 0.300 **(clamped)** | 0.300 **(clamped)**           | 0.80      | 0.966          |
| 1440×900  | 0.305               | 0.396                         | 0.80      | 1.040          |
| 1512×982  | 0.367               | 0.458                         | 0.80      | 1.112          |
| 1920×1080 | 0.441               | 0.532                         | 0.80      | 1.520          |

**THE RULE, in one sentence a code card can implement with no second decision:** _fit the level when
`fitView`'s scale is at or above 0.80; otherwise arrive at 0.80, centred on the level's focal card._

Three clauses it needs, and the second is the one that stops the result looking wrong:

- **The focal ladder is the shipped LOCATE ladder** — `here` → the first `ready` node → the level's
  first node in layout order.
- **Centring is PER AXIS.** On an axis where the level FITS at the floor, centre the level's BOUNDS;
  on an axis where it does not, centre the focal CARD. The root level is 800 px wide at 0.80 in a
  1136 px box, so it is centred horizontally and only the vertical follows the frontier — centring
  the card on both axes parks a first-column card in the middle and leaves a third of the canvas
  empty.
- **It is an ARRIVAL, not a floor on zoom.** `MIN_SCALE = 0.3` is untouched; a reader who wants the
  whole eighteen-epic level still zooms out to it.

The "you are here" ring is the card's own — the accent border + map-pin pill `WorkItemNode` already
draws for `here`. Nothing new is painted to make the centring read as deliberate.

### 3. The Dependencies panel COLLAPSES, in place

Measured: the shipped legend is **385×100 px** (**385×104** once the chevron joins its heading row)
and sits over the bottom-left of the graph for ever, having taught its three arrow styles once.
Collapsed it is **141×38 px** — **86.6%** of the overlay area handed back to the canvas.

- **It collapses IN PLACE.** The slot (`bottom-[4.25rem] left-3`) is unchanged, so the control does
  not move under the reader's cursor and the panel can never collide with the zoom cluster at
  `bottom-4 left-4`. Only the three rows above it go.
- **The affordance is a chevron ON the panel's own heading row**, not a bare pill: the heading is the
  one thing that must survive collapse (a legend with no heading is unfindable), so the control
  belongs beside it. `ChevronDown` expanded, `ChevronUp` collapsed — the direction the panel moves.
- **Copy + catalogue keys.** Accessible name `Hide the dependency legend` when expanded and
  `Show the dependency legend` when collapsed, under **`roadmap.canvas.legend.collapse`** and
  **`roadmap.canvas.legend.expand`**. Both land in `messages/en.json` AND `messages/zh.json` in the
  same pull request (the i18n en↔zh parity gate). The heading keeps its existing
  `roadmap.canvas.legend.heading` key. **Adding those keys and rendering the control is NOT this
  card's** — it is the collapsible-legend card's.
- **A11y.** A real `<button>` carrying `aria-expanded`, controlling the legend rows via
  `aria-controls`; the caption is text, not a second button; the chevron is `aria-hidden`; the focus
  ring is the shared `--focus-ring-color`.
- **Tokens, all reused from the panel it lives on:** surface `--el-surface`, edge `--el-border`,
  radius `--radius-card`, elevation `--shadow-card`, the 10.5 px tracked uppercase caption in
  `--el-text-secondary`; the toggle is `--radius-control`, 20×20, glyph `--el-text-secondary`. No
  second overlay language is invented.
- **Persistence is the SHIPPED client-preference pattern** — `lib/hooks/useAttachmentsView.ts`'s
  `useSyncExternalStore` + module-cached snapshot + a `motir.*` key. Key
  **`motir.roadmap.legend.collapsed`**, server snapshot **expanded** (today's behaviour), so SSR
  paints the stable default and the stored choice applies right after hydration with no
  `setState`-in-an-effect. No server-side per-user view preference.
- The sprint-scope variant (MOTIR-1379) collapses identically — its warning row is a
  `warningLegend` override, not a second panel.

### 4. The URL states — SEMANTICS and the two fallbacks

| URL                                     | the level in view                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/roadmap`                              | the project ROOT. Canonical — the param is omitted, as `?scope=` omits `project`                                |
| `/roadmap?item=MOTIR-1234`              | the level whose members are **MOTIR-1234's CHILDREN** — you land _inside_ it, which is where a drill leaves you |
| `/roadmap?scope=sprint&item=MOTIR-1234` | composes with the shipped scope param (MOTIR-1541); two independent view-state params on one route              |

- **Both fallbacks are SILENT, and land at the root.** An `item` that does not resolve, or that the
  viewer cannot browse, falls back to the root level — the same silent catch `/planning` already uses
  for its `?item=` anchor (`app/(planning)/planning/page.tsx`). So does an `item` outside the
  active-sprint slice when `scope=sprint`. No error state and no toast: a stale link is not a
  failure, it is a level that no longer exists.
- **An `item` with NO CHILDREN opens its PARENT's level, with that node SELECTED.** A drill can never
  write one — the canvas only drills a `drillable` node — but a hand-edited link can, and "the level
  whose children are none" is an empty canvas that reads as a failed load. A parentless childless
  item falls back to the root. The selection is the canvas's shipped `selectedId`, not a new
  highlight.
- **The trail is SEEDED, not guessed.** The server resolves the anchor's ancestor chain with
  `workItemsService.getWorkItemWithAncestors` and hands it to the canvas's shipped `initialTrail`
  prop (MOTIR-2070), so the breadcrumb reads identically to a hand-drilled one.

### The INTERACTION spec (three of the four refinements are BEHAVIOUR)

A static arrangement under-specifies this surface, so the behaviour is stated here and the cards that
OWN each behaviour are cited rather than invented — this design READS their descriptions
(`relates_to`), it does not define them.

| the reader does…       | the level          | the URL                                                 | scale + pan        | owned by                                         |
| ---------------------- | ------------------ | ------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| drills a node          | its children       | **pushed** `?item=<KEY>`                                | a new ARRIVAL (§2) | the canvas seam + the level-addressable-URL card |
| clicks **Back**        | the parent level   | **pushed** (the parent, or bare `/roadmap` at the root) | a new ARRIVAL      | the same two                                     |
| clicks a crumb         | that crumb's level | **pushed**                                              | a new ARRIVAL      | the same two                                     |
| presses browser Back   | the previous level | the URL is the source of truth                          | a new ARRIVAL      | the level-addressable-URL card                   |
| reloads / opens a link | the `?item=` level | unchanged                                               | a new ARRIVAL      | the level-addressable-URL card                   |
| collapses the legend   | unchanged          | unchanged                                               | unchanged          | the collapsible-legend card                      |

- **The write is a PUSH, not a replace**, and it is SHALLOW (`lib/navigation/shallowUrl.ts`). Back
  must return to the previous level — MOTIR-1549 exists because the scope toggle once used a replace
  and Back stopped restoring it — and the level is already in the browser, so the server has nothing
  to re-answer.
- **Scale and pan on a URL restore are the ARRIVAL, not a saved viewport.** Nothing persists a pan.
- **Only the collapse persists** (`motir.roadmap.legend.collapsed`), per §3.

### Token / a11y discipline (same rules as the canvas)

- **Colour** via `--el-*` only. The board's own annotation ink is `--el-text-secondary` (6.18–6.80:1
  on every surface it lands on); measurement rules and the `?item=` fragment are
  `--el-accent-on-surface`; the dead-band call-out is an `--el-tint-peach` fill with
  `--el-text-strong`. The orb is drawn as its FOOTPRINT — an `--el-accent` disc with
  `--el-accent-text` — because this asset is about clearance, not about the orb's material, which
  `design/ai-chat/design-notes.md` owns. No invented hue anywhere; the only raw values are the
  non-semantic frame outlines.
- **Shape** via element-semantic tokens: overlays and canvases `--radius-card`, the Reset button
  `--radius-btn` with `--spacing-btn-x/y`, the rail rows `--radius-control` at `--height-control`,
  chips `--radius-badge`, address bars `--radius-input` with `--spacing-input-x/y`. No raw
  `rounded-*` / `p-*` / `h-*`.
- **A11y** — the collapse toggle is a real `<button>` with an `aria-label`, `aria-expanded` and
  `aria-controls`; every decorative glyph is `aria-hidden`; the "you are here" node keeps its shipped
  `aria-current="step"`; no nested interactive elements. The frames use `outline`, not `border`, so a
  drawn viewport measures the width it claims.

### How the asset was produced (reproduced here rather than cited — the harness is deleted)

The mock is the app's own markup. It was produced by a throwaway Vitest dump under a config with no
`globalSetup` (so the root config's per-worker Postgres provisioning never runs), then composed and
measured in Chromium:

```ts
// a throwaway Vitest spec under the component-test tree, deleted before the commit
// @vitest-environment happy-dom
const level = buildWorkItemLevel({ items: rows, edges, offLevelBlockers: [] }, { markActive: true });
const pos = deterministicLayout(level.nodes.map((n) => n.id), level.deps);
// one entry per node: { id, x, y, html: renderToStaticMarkup(intl(n.content)) }
render(intl(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)}
  searchable fullScreenable locatable onResetPositions={() => {}} onNodeMove={() => {}} />));
await waitFor(() => screen.getByTestId('edge-legend'));
writeFileSync('canvas-chrome.html', document.querySelector('[data-testid="roadmap-canvas"]').outerHTML);
render(intl(<RoadmapView projectKey="MOTIR" projectName="Motir" hasActiveSprint … />));
writeFileSync('page-shell.html', document.body.innerHTML); // the real page header
```

```js
// the stylesheet inlined in the mock IS Tailwind's real output for this document
// @import 'tailwindcss' source(none); @source './roadmap-arrival.mock.html';
// @import '@motir/design-system/theme.css'; @import '@motir/brand/brand.css';
postcss([tailwindcssPostcss()]).process(input, { from: inputPath });
```

Measurement: Chromium at `deviceScaleFactor: 1` for the legibility read (a 2× export flatters small
type), at the four viewports above for the fold, reading `getBoundingClientRect()` and
`getComputedStyle().fontSize` on the real elements. The PNG is re-exported with the shipped
`node scripts/render-design-mock.mjs design/roadmap/roadmap-arrival.mock.html --width 1200`, **after**
`prettier --write` on the mock.

### ⚠️ Planning flags — surfaced by this pass, owned by no card in MOTIR-3833

1. **The 3-column layout wastes the canvas's WIDTH, and that is what forces the arrival scale down.**
   `deterministicLayout` is fixed at `COLS = 3`, so an 18-node level is a 1000×1324 world box —
   taller than wide — inside a canvas that is 1136×620 and wider than tall. `fitView` is therefore
   bound by HEIGHT at every viewport measured, and today's arrival leaves 30–50% of the horizontal
   room empty. A column count that responded to the viewport would raise the fit scale before any of
   this story's changes did. Outside MOTIR-3833's scope boundary as written; a follow-up, not a
   silent widening of the arrival card.
2. **`min-h-[28rem]` still makes `/roadmap` scroll on a short window.** The full-fold card removes the
   symptom at 1366×768 (the computed height becomes 488, so the floor stops binding), but the floor
   itself is untouched, so a shorter window still scrolls the one signed-in surface the shell
   promises never scrolls. Whether a canvas should carry a minimum height at all is a decision
   nobody has made.
3. **The Reset-layout / orb overlap is a SHIPPED defect, not one this story introduces** — measured
   at 1366×768 today, the button overlaps the orb by 19 px, because the `min-h` floor already pushes
   the canvas past the band the shell reserved. The full-fold card's lift fixes it as a side effect;
   recorded here so it is not re-discovered as a regression of this story.
4. **Nothing persists a canvas PAN or ZOOM, and this asset deliberately does not add it.** §4 settles
   that a URL restore is an ARRIVAL — the level is addressable, the viewport is not. A per-level
   saved viewport would be its own story with its own storage decision, never a clause in the arrival
   rule.

---

## ⭐ A FOLDER on the canvas (MOTIR-5713 — `roadmap--folder-node.mock.html`)

The card this unblocks is **MOTIR-5710**. Folders shipped in Epic MOTIR-5307: a project's tree can
be tidied into nestable folders that hold any work item and carry no workflow. The roadmap never
learned about them. `workItemsService.getProjectRoadmap` calls `findProjectTreeLevel` /
`countProjectTreeLevel` **without** a `TreeFolderLevel` argument
(`lib/repositories/workItemRepository.ts`, whose own comment says the roadmap omits it on purpose),
so a filed root is still a root and no read returns a folder. Only the drilled breadcrumb shows a
folder today, and only as TEXT (`crumbFolderPath`, MOTIR-5418). Two surfaces showing one project
therefore disagree about its shape: `/items` shows two tidy folders, and the canvas shows 888 loose
bugs.

**This reverses one decision on the record.** Story MOTIR-5309 chose _"Guards, not features, for
the roadmap … The roadmap is unchanged. Its root lists a filed epic exactly as it did before."_ That
guard is what this design retires. The code card must **restate** MOTIR-5309's vitest guard for the
roadmap (a filed row now leaves the root), not work around it. The public-project half of that guard
stands (decision 8).

**A delta, per the area's rule.** `roadmap--folder-node.mock.html` holds only the panels that
change. It amends, without editing:

| amended mock                                     | what changes                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `roadmap.mock.html`                              | the canvas gains a new node kind (the folder card) and a new level kind (a folder level)                       |
| `root-non-epic-rows.mock.html`                   | the root's loose band now leads with folders; **Not in an epic** holds only UNFILED parentless non-epics       |
| `../ai-planning/plan-folder-placement.mock.html` | on the ROADMAP only, the folder crumb becomes a navigable `Crumb`; the plan-review canvas keeps its text crumb |

**What it composes, and redraws nothing of.** The node box, kind tile, identifier and title slots,
chevron, status pill, meter, grouped node, truncation tile and ghost anchor are
`components/planning/WorkItemNode.tsx` (`WorkItemNode`, `LevelGroupNode`, `LevelTruncationTile`, the
ghost anchor), mirrored class-role for class-role. The breadcrumb nav and `Crumb` are
`components/planning/ProjectRoadmapCanvas.tsx`. The folder vocabulary is
`components/planning/FolderPlacement.tsx` (the lucide `folder` glyph, `FolderPathLabel`,
`collapseFolderPath`, the `▸` separator) and the `/items` folder rows of
`design/work-items/folders.mock.html` (MOTIR-5311), which is the rung-1 precedent for every
decision below. The canvas is a **per-level drill-down** fed one level per fetch
(`getProjectRoadmap` → `findProjectTreeLevel`). The folder card is a new node kind INSIDE that
canvas and that read, not a second canvas and not a whole-tree read.

### Sheets

| #   | sheet                  | what it settles                                                                                                                                              |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Today**              | The shipped defect: filed bugs still count against the root cap and still sit behind **Not in an epic**; no folder appears.                                  |
| 2   | **The folder card**    | The shipped node box with the folder glyph tile, the direct-contents count, the name. No status, meter or readiness. At rest · selected · empty · long name. |
| 3   | **The root level**     | Epics on the road; the loose band leads with the folders (position order), then **Not in an epic**.                                                          |
| 4   | **Inside a folder**    | Its child folders first, then its filed work items, each unchanged. The shipped cap tile counts the folder's work items.                                     |
| 5   | **The breadcrumb**     | Before/after: each folder is its own `Crumb` button led by the folder glyph; a deep path collapses from the middle.                                          |
| 6   | **An empty folder**    | Still drawn, still a door; the drilled-empty slot gets folder copy.                                                                                          |
| 7   | **Edges**              | A folder is never an edge end. A filed off-level blocker's ghost anchor names its folder path.                                                               |
| 8   | **Decisions + scopes** | The eight decisions below, in one table.                                                                                                                     |
| 9   | **Dark parity**        | A drilled folder level on `data-theme="dark"`; the "Toggle dark" button flips every sheet.                                                                   |

### DECISION 1 — every FILED work item leaves the root read

The roadmap passes the same `{ kind: 'excludeFiled' }` treatment the `/items` root read passes
(MOTIR-5314), to both `findProjectTreeLevel` and `countProjectTreeLevel`, so a level's rows and its
"Showing N of M" keep sharing one predicate. A filed epic leaves the road and appears inside its
folder. A folder level reads `{ kind: 'folder', folderId }`. The level's address becomes a parent id
**or** a folder id: the route `GET /api/projects/[key]/roadmap` and
`lib/planning/roadmapClient.ts` `fetchRoadmapLevel` need a folder form, and the URL-addressable
level (`?item=`, MOTIR-3836) needs one too, so a folder level survives reload and a shared link.

### DECISION 2 — folders lead the loose band, at every level

The epics stay on the road where `deterministicLayout` puts them. A folder takes part in no edge,
so it already falls into the loose band below the flow. Within that band **the folders come first,
in their own position order** (as `/items` keeps them under any column sort), and then:

- at the ROOT, the **Not in an epic** node, last;
- in a FOLDER, the loose work items.

This is the `/items` root order (_epics, then folders, then the rest_, review of MOTIR-5540)
expressed in the canvas's layout rather than as a list.

**Not in an epic is ROOT-ONLY.** Inside a folder, the folder is already the drawer. Grouping its
non-epics again would put a second door in front of the room the reader just opened.

### DECISION 3 — the card counts DIRECT contents, folders and items named separately

`794 items` · `1 item` · `2 folders · 5 items` · `3 folders` · `Empty`. Direct, as the `/items`
delete confirmation counts (`folders.mock.html` panel 5): a filed epic counts once, however many
stories it holds. It is **not** recursive and **not** a status tally. A folder is not a unit of work,
and a done/open split on its face would be the progress claim decision 3 of the grouped node already
refused. The count needs one aggregate per level (child-folder count + filed-row count per folder);
it must not be computed by loading each folder's contents.

### DECISION 4 — the 200-row cap is about WORK ITEMS; folders are never cut

A level's folders are read whole, as `list_folders` / the `/items` folder tree are, and drawn before
the cap tile. `levelTotal` and the tile's `Showing {shown} of {total}` count **work items only**, so
the sentence stays true. This keeps the cap from ever hiding the doors to the work it did not show.

### DECISION 5 — a folder is a CHOICE, not decoration

Not `decorative`, for the grouped node's reason (its decision 5): a folder holds real work, so it
counts toward `autoDescendSingleParent`'s "does this level offer a choice?". A root with one epic and
one folder does **not** auto-descend into the epic. Not `viewable` either: it has no peek, because
what it holds is the level behind it. Selecting it shows the shipped **Open ›** button and no
**View**.

### DECISION 6 — sprint scope ignores placement

Under `scope=sprint` **no folder is drawn and placement is ignored**. A filed in-sprint row renders
exactly where it would if it were unfiled. The sprint view exists to show committed work, and putting
a committed bug behind a folder door would bury the thing the view is for. The level read therefore
passes no folder treatment when `sprintId` is set.

### DECISION 7 — edges: a folder is never an edge end; a filed blocker is named with its folder

A folder blocks nothing, draws no arrow and never takes the cross-blocked chrome. Edges keep the rule
the grouped level already follows (MOTIR-3557): **a level draws the edges whose BLOCKED end is one of
its rows**. What changes is the **ghost anchor's location line**. For an off-level blocker that is
FILED, the line reads its **folder path**, drawn with `FolderPathLabel` (glyph + path, `max` 2),
where today it reads the parent or "elsewhere". The off-level blocker payload needs the blocker's
effective folder path for that. The reader learns which door holds the blocker.

### DECISION 8 — what stays out

- **The run canvas** (`ids=` levels): a run's members are drawn as the run took them, and an explicit
  id set already ignores `TreeFolderLevel` by construction.
- **The public roadmap** (`publicProjectsService`): carries no folder field, per MOTIR-5309's
  decision, which this card does not reverse.
- **The plan-review canvas's folder crumb** (MOTIR-5418): there the path says where a PROPOSAL will
  be filed. That canvas has no folder level to navigate to, so its text crumb stands.
  **⚠️ SUPERSEDED (MOTIR-5793, 2026-09-19):** bug MOTIR-5782 gives both planning canvases folder
  levels, and `design/ai-planning/design-notes.md` Part XVIII makes their folder crumbs navigate.
  This bullet is kept as the record of the decision it was.
- **Search-to-locate inside an unopened folder**: a folder card's search text is its name. Locate
  still searches the level in view, as today.

### The breadcrumb (sheet 5)

The roadmap's crumb chain becomes **root › folder › … › folder › work item › …**, and each folder
is its own shipped `Crumb` button: `--el-text-secondary`, hover `--el-surface-soft` + `--el-text`,
active `--el-text` 600 with `aria-current="page"`. A 14px lucide `folder` glyph leads the label, so a
folder crumb reads as a folder without the reader reading it. Its accessible name is the shipped
`folders.breadcrumbFolderLabel` ("Folder:") + the name. **More than three folders collapse from the
middle** (`collapseFolderPath(path, 3)`), and the `…` is itself a `Crumb` that navigates to the
folder just above the last one shown. It carries the full path as its `title`. Clicking a folder
crumb navigates to that folder's level, exactly as a work-item crumb navigates to its level.

### Elements — primitive and tokens

| element                  | composes                                              | colour                                                                                                                  | shape                                                 |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| folder card box          | `LevelGroupNode`'s box (`NODE_W × NODE_H`)            | `--el-surface`, border `--el-border`                                                                                    | `--radius-card`, `--shadow-card`, `p-3.5`             |
| folder tile              | the kind-tile slot, `size-7`                          | fill `--el-muted`; lucide `folder` in `--el-text-secondary` (`aria-hidden`)                                             | `--radius-control`                                    |
| count                    | the identifier slot, mono `text-xs`                   | `--el-text-secondary`                                                                                                   | —                                                     |
| name                     | the title slot, `line-clamp-2`, 600                   | `--el-text`                                                                                                             | —                                                     |
| drill chevron            | the shipped chevron, `data-testid="drill-affordance"` | `--el-text-muted` (decorative glyph, `aria-hidden`)                                                                     | `size-4`                                              |
| Open ›                   | the shipped selected-node drill button                | `--el-accent` / `--el-accent-text`                                                                                      | `--radius-btn`, `--spacing-btn-x` / `--spacing-btn-y` |
| folder crumb             | the shipped `Crumb` + a lucide `folder` glyph         | `--el-text-secondary`; hover `--el-surface-soft` + `--el-text`; active `--el-text`; separator `--el-text-faint` (glyph) | `--radius-control`, `max-w-[18rem]` truncate          |
| empty folder level       | the canvas's drilled-empty slot                       | lucide `folder-open` + description `--el-text-secondary`; title `--el-text-strong`                                      | —                                                     |
| ghost anchor folder line | `FolderPathLabel` inside the shipped anchor           | `--el-text-secondary`                                                                                                   | `size-3.5` glyph                                      |

### Copy — English and Chinese

Keys are suggestions for the code card; each needs its `messages/zh.json` twin in the same pull
request. The ones under `roadmap.canvas.folder` sit beside the shipped `roadmap.canvas.group`.

| key (suggested)                          | en                                                           | zh                                                 |
| ---------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `roadmap.canvas.folder.items`            | {count} items                                                | {count} 项                                         |
| `roadmap.canvas.folder.itemsOne`         | 1 item                                                       | 1 项                                               |
| `roadmap.canvas.folder.folders`          | {count} folders                                              | {count} 个文件夹                                   |
| `roadmap.canvas.folder.foldersOne`       | 1 folder                                                     | 1 个文件夹                                         |
| `roadmap.canvas.folder.both`             | {folders} · {items}                                          | {folders} · {items}                                |
| `roadmap.canvas.folder.empty`            | Empty                                                        | 空                                                 |
| `roadmap.canvas.folder.aria`             | Folder {name}, {contents}. Open to see what is filed in it.  | 文件夹“{name}”，{contents}。打开以查看其中的内容。 |
| `roadmap.canvas.folder.emptyTitle`       | This folder is empty                                         | 此文件夹为空                                       |
| `roadmap.canvas.folder.emptyDescription` | Work items filed into {name} from Work items will show here. | 在“工作项”中归入“{name}”的工作项会显示在这里。     |

The crumb's accessible prefix is the shipped `folders.breadcrumbFolderLabel`; the `…` crumb's
accessible name is its full path. **No other new strings.**

### Tokens & a11y

Colour is `--el-*` only and shape is the element-semantic tokens. Every piece of text sits on
`--el-text-secondary` or stronger, which clears AA on every surface in both themes.
`--el-text-muted` and `--el-text-faint` appear only on decorative, `aria-hidden` glyphs (the
chevron, the crumb separator), exactly as the shipped canvas uses them. The folder card is one
focusable node whose `aria-label` carries name + contents, as `LevelGroupNode`'s does. The folder
crumb is a real `<button>` in the breadcrumb `<nav>`'s ordered list.

### Allocation — what this design GIVES and TAKES

Swept over the tree, not only over the keys this asset names (`type-design.md`'s allocation rule):

| key                             | gives / takes                                                                                                                         | disposition                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **MOTIR-5710**                  | GIVES the whole build: the folder read arm, the level address, the folder card, the folder level, the crumb, the anchor's folder line | the card is amended on the record in the same pass (acceptance criteria + a re-estimate) |
| **MOTIR-5309**                  | TAKES a PREMISE: "the roadmap is unchanged" — its roadmap guard is retired                                                            | a `done` story; not reopened. MOTIR-5710's criteria carry the guard's restatement        |
| **MOTIR-5418**                  | TAKES nothing: the plan-review text crumb stands (decision 8)                                                                         | none owed                                                                                |
| **MOTIR-3493** / **MOTIR-3490** | TAKES a STRUCTURE on the ROOT: the grouped node now holds only unfiled rows, and the loose band leads with folders                    | both `done`; MOTIR-5710 carries the change                                               |
| **MOTIR-5311** / **MOTIR-5314** | GIVES nothing, TAKES nothing: their vocabulary and level rule are composed as they stand                                              | none owed                                                                                |

---

## Covered cross-parent edges (MOTIR-6015)

_MOTIR-6353, Story MOTIR-6352 — `edges--covered-by-parent.mock.html`, a DELTA of `edges.mock.html`
sheet 2. It amends [§3](#3-cross-level--cross-story-signal--the-off-level-blocker-the-heart-sheet-2),
and `edges.mock.html` is left as the record it is._

Story MOTIR-6015 made a SAME-LEVEL `blocked_by` across parents a legitimate edge: a subtask may wait
on a subtask in another story, and a story on a story in another epic. Such an edge is **valid
exactly when the parents carry it**. §3 was written for a world where every off-level blocker was a
planning error (_"a correct plan is a tree"_), and it painted all of them as the bad-plan tangle.
Under the new rule most of those edges are correct. Painting them red would turn the canvas's
loudest signal into noise on exactly the plans the planners now draw well.

### The rule

> **Project scope: an off-level blocker shows _blocked elsewhere_ if and only if the validator calls
> the edge INVALID.**

An off-level edge is one of four things, and the canvas treats each one differently:

| the edge                                                                                                                                           | validator verdict                                                                           | canvas (project scope)                                                                                                                                 | sheet |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| **UNCOVERED** — same level, different parents, and the blocked item's parent is NOT directly `blocked_by` the blocker's parent                     | INVALID — `invalidEdges` (`validate_work_item`, `validate_plan`)                            | the shipped §3 treatment, unchanged: `cross` arrow, ghost anchor, midpoint flag, _blocked elsewhere_ pill + ring                                       | 1, 3  |
| **COVERED** — same level, different parents, and the blocked item's parent IS directly `blocked_by` the blocker's parent                           | valid                                                                                       | **nothing at this level**: no arrow, no anchor, no flag, no pill, no ring. The parents' in-level arrow one level up already draws the dependency       | 2, 4  |
| **EXEMPT** — same level, and an end has no work-item parent (a root, or an item FILED in a folder)                                                 | valid (`coveredByParents`: "no parent edge to require")                                     | **NEW: the neutral anchor.** The ordinary in-level arrow (pending, or firm once done) from a ghost anchor in neutral tokens. No flag, no pill, no ring | 7     |
| **CROSS-LEVEL** — the two ends sit at different depths below their nearest common ancestor, or an epic paired with a non-epic (`isCrossLevelEdge`) | INVALID — "blocked elsewhere" (the user's ruling of 2026-09-26, recorded on bug MOTIR-6509) | the §3 treatment, as UNCOVERED. Coverage is never asked of it: a cross-level edge is invalid whatever its parents carry                                | —     |

**"Directly"** means ONE `is_blocked_by` link from the blocked item's parent to the blocker's parent,
exactly as `coveredByParents` (`lib/workItems/crossParentCoverage.ts`) reads it: not transitive (B
waiting on C waiting on A does not cover B's child waiting on A's child), and never a grandparent
(the epics carrying an edge does not cover a subtask edge between their stories). The rule recurses
by being asked of EVERY edge. The story edge that covers a subtask edge is itself judged at the story
level against the epics.

**One predicate, never a second copy.** The canvas asks `lib/workItems/crossParentCoverage.ts`
(coverage and exemption) and `lib/workItems/edgeLevel.ts` (`isCrossLevelEdge`), the same two
functions the validators call. So the flag and the verdict cannot disagree, and
`tests/workItems/crossParentCoverage.test.ts` already pins that nothing defines a second copy.

### Why each non-obvious state is decided the way it is

- **Covered draws NOTHING, not a quieter arrow (sheet 2).** The card's reader asks _"is this plan
  wrong here?"_. A covered edge's answer is no, and the dependency itself is legible one level up,
  where the parents' arrow runs. A second, softer anchor at the leaf level would reintroduce
  off-level chrome on every precise edge the planners now draw. It would compete with the one warning
  the canvas has, for information the reader already has. **Readiness is untouched**: the edge still
  holds the card out of the ready set; only its drawing changes.
- **Mixed keeps the pill (sheet 3).** The pill says _this card has an invalid edge_. One is enough.
  The pill never counts or names the covered blocker, and only the uncovered blocker gets an anchor.
  The shipped anchor-dedupe (`anchorAdded`) already mints one anchor per blocker, so an anchor shared
  with a covered edge is drawn only if some uncovered edge needs it.
- **Done-ness does not decide (sheet 5).** What the canvas ships today: in project scope a DONE
  off-level blocker is drawn exactly like an open one (`stub.isDone` is read only in the sprint arm).
  Coverage keeps that: the verdict is about the plan's SHAPE, and `invalidEdges` does not read status.
  So an uncovered done blocker stays flagged, and a covered done blocker is hidden like any covered
  edge. The canvas never flags an edge the validator calls valid, and never hides one it calls
  invalid.
- **The exempt edge keeps an anchor, in NEUTRAL tones (sheet 7).** Being valid, it gets no warning.
  But unlike a covered edge, no level above draws it (a root has no parent level), so hiding it would
  make a real dependency invisible on the whole roadmap. Same-level plus exempt is only reachable
  between two ROOTS, and it reaches the canvas as an off-level blocker when one of them is filed (a
  filed item leaves the root read and is drawn inside its folder level, MOTIR-5713 decision 1).
  MOTIR-5713 decision 7 designed exactly this anchor's folder line, and it stays: the reader still
  learns which folder door holds the blocker.
- **A cross-level edge is always flagged.** `coveredByParents` does not consult the level, so on its
  own it would call a cross-level edge between two parents that happen to be linked "covered". The
  canvas must ask `isCrossLevelEdge` FIRST, as `uncoveredCrossParentEdges` does. Bug MOTIR-6509 makes
  such an edge writable and reports it INVALID with the reason "blocked elsewhere", so the flag is its
  on-canvas form.

### The neutral anchor (the one new element)

Derived from the shipped `GhostAnchor` (`components/planning/WorkItemNode.tsx`). Same box
(`200 × NODE_H`, `overflow-hidden`, `--radius-card`, dashed border, `p-(--spacing-card-padding)`),
same three lines (the `ArrowUpRight` identifier, the title, the location or folder line), same
hatch geometry. Only the tone changes:

| part             | danger (§3, invalid)                              | neutral (valid, exempt)                                              |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| border           | dashed `--el-danger`                              | dashed `--el-border-strong`                                          |
| hatch            | `--el-surface` / `--el-danger-surface`            | `--el-surface` / `--el-border-soft`                                  |
| identifier       | `--el-danger-on-surface`, 600, mono               | `--el-text-secondary`, 600, mono                                     |
| title            | `--el-text-secondary`                             | `--el-text-secondary` (unchanged)                                    |
| location line    | "in {parent} ↗" `--el-danger`, or the folder path | the folder path (`FolderPathLabel`, `--el-text-secondary`), as today |
| edge into target | `cross`: `--el-warning`, 2.5, midpoint flag       | `firm` / `pending` by the blocker's status, 2, **no flag**           |
| blocked node     | `cross-blocked` state: danger ring + pill         | `normal` (or whatever other state it has — done, ready, here)        |

It keeps the anchor's behaviour: viewable (MOTIR-1586), and a click drills to the blocker's level.
Its accessible name is the shipped anchor's.

### The legend (sheet 6)

The label stays **blocked elsewhere** / **受阻于别处**. The meaning
(`roadmap.canvas.legend.blockedElsewhereMeaning`) stops describing where the blocker is, which is
true of every covered edge too, and names what is wrong and the remedy:

| key                                             | en (today → after)                                                                                            | zh (today → after)                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `roadmap.canvas.legend.blockedElsewhereMeaning` | the blocker sits elsewhere in the plan → **its parent isn’t blocked by the blocker’s parent — add that link** | 阻塞项位于计划中的别处 → **其父项未被阻塞项的父项阻塞——请补上这条关联** |

The copy names the cross-parent remedy, because that is the case the planners now produce. A
cross-level edge shares the row. Its remedy is to re-wire the edge on one level, which the anchor's
location line and the validator's reason tell the reader. A second legend row for a rare, now
planner-refused shape would cost more reading than it saves. **No other new strings**: the pill,
the midpoint flag and the anchor keep their shipped copy.

### Plan review

The plan-review canvas composes the same level builder (`mergePlanLevel`), so every state above
applies there over the PROJECTED tree. A plan that adds the parents' edge (a `modify` with
`blockedByAdd` on the parent, or an `add` carrying it) previews the child edge as covered, and a
plan that removes it previews the flag. The `validate_plan` verdict is the reference, as
`validate_work_item` is for the committed roadmap. No separate sheet: the drawing is identical, and
only the tree the predicate reads differs.

### Unchanged — and not drawn

- **Sprint scope** (`blockerNotInSprint` / `blockerNotInSprintMeaning`, the _"not in this sprint ↗"_
  anchor): sprint validity is a different question, and its arm runs before any of this. Unchanged.
- The in-level firm / pending arrows, the ghost anchor's anatomy, the midpoint flag's copy, the
  arrival / level-member / grouped / departing exclusions in `buildWorkItemLevel`.
- No soft / hard block marker (Story MOTIR-6354's; excluded here).

### Shipped reality this asset records

- The shipped `cross` edge, its marker and the legend's warning swatch are `--el-warning`, not the
  `--el-danger` §3 names. The anchor and the node ring are `--el-danger`. The mock draws what ships.
- Every canvas in the mock is the real `ProjectRoadmapCanvas` + `buildWorkItemLevel` markup, rendered
  headless from each state's level data (the harness recorded under _How the asset was produced_
  above, with a throwaway spec deleted before the commit), and the stylesheet is Tailwind's real
  output for the document over `packages/design-system/theme.css`. The covered panels are what the
  builder renders once a covered edge is dropped before the off-level branch.

### Tokens & a11y

Colour is `--el-*` only and shape is the element-semantic tokens. The neutral anchor's text is
`--el-text-secondary` on `--el-surface` / `--el-border-soft`, which clears AA in both themes, as the
shipped anchor's title already does. The pill, the flag and the anchor are not colour-alone: each
keeps its glyph and label.

### Allocation — what this design GIVES and TAKES

| key                             | gives / takes                                                                                                                                                                                                                                                   | disposition                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **MOTIR-6359**                  | GIVES the committed-roadmap build, and TAKES a premise: coverage is not a boolean. The read reports each off-level edge as uncovered / covered / exempt / cross-level; the builder skips covered, draws exempt with the neutral anchor, and flags the other two | amended on the record in the same pass (criteria + a re-estimate) |
| **MOTIR-6362**                  | GIVES the same four dispositions over the projected tree                                                                                                                                                                                                        | amended on the record (one criterion)                             |
| **MOTIR-6365** / **MOTIR-6373** | GIVE the exempt case to assert: the neutral anchor at the root, and no flag                                                                                                                                                                                     | amended on the record (one criterion each)                        |
| **MOTIR-6352**                  | TAKES a wording: "flags exactly `invalidEdges`" becomes "flags exactly the edges the validator calls invalid", since MOTIR-6509 moves cross-level edges into that verdict                                                                                       | amended on the record                                             |
| **MOTIR-6509**                  | TAKES nothing: its verdict is what this design flags                                                                                                                                                                                                            | none owed                                                         |
| **MOTIR-5713**                  | TAKES nothing: decision 7's folder line is kept, on the neutral anchor                                                                                                                                                                                          | none owed                                                         |

## Warm touches in the default Motir palette (MOTIR-7583)

**Amends** `design/roadmap/roadmap.mock.html`'s COLOURS only — no layout, copy or component change.
Delta mock: `design/roadmap/roadmap--motir-warm-touches.mock.html`. The spec — the role table, the
measurement matrix, the roadmap's own figures and the hand-off — is
`design/design-system/design-notes.md` § 8 (§ 8.9 for the roadmap), because the change is a palette
change and that is the palette's area.

What the panels show, today vs proposed, light and dark: the root level of epics, where every Epic
glyph turns from blue to warm orange on its rose tile (3.01:1 light, 4.84:1 dark), and the Blocked and
Planning chips warm slightly; and a drilled level, where only the Bug tile's peach warms. The
You-are-here pill, the Ready wash, the Done card, the green meters and every edge are unchanged. The
citrine Design hue does not reach the roadmap, because a node draws a kind icon rather than a
work-type chip.

## "You are here" moves off the tag row onto a tab (MOTIR-10629)

**Amends** design **MOTIR-10508**: its notes section _The canvas card, re-laid: tag row, title-only
body, To plan, next action (MOTIR-10508)_ and its delta mock `roadmap--canvas-card-tag-row.mock.html`
(the "You are here" card in its panels 3, 4, 10 and 11), both as published on MOTIR-10508. Delta mock: `design/roadmap/roadmap--here-tab.mock.html`. Panel 1
of the delta renders what `main` ships today, so the change reads against the real card.

**Design system, checked first.** `package.json` depends on `@motir/design-system` (`workspace:*`,
version 0.20.0) and `app/globals.css` imports `@motir/design-system/theme.css`, so the project is on
Motir Design. Its axes come from `app/layout.tsx` (`data-style` / `data-palette` / `data-type` from the
applied theme); the mock draws at `warm-editorial` · `motir` · `motir`, the defaults the app applies,
and panels 4 and 5 re-scope every style. The mock is built with `renderMock` from
`@motir/design-system/mock` (`boardWidth: 'full'`). No new token, no new design-system part. One new
product-local piece: **`HereTab`**, a slot of `WorkItemCardShell` in
`components/planning/WorkItemNode.tsx` (canvas-only, so it stays out of the package).

### The problem it fixes

`HerePill` is passed to `WorkItemStateTags` as `slotOverride`, so it takes the status slot: the here
card never shows its status (In Progress, In Review…), and when a right-hand text tag is present the
give-way rule cuts the pin and the Manual chip to glyphs. The card the reader most needs to read shows
the fewest facts (panel 1).

### What the panels show

0. Where it sits: a slice of the roadmap canvas at 1×, two rows at the layout's real spacing, with a
   selected card above (its View / Open slot in the gap), the here card hovered (tab and next-action
   button together) and a row-wrap edge entering the here card's top.
1. Was: the shipped `WorkItemNode`, every state the card asks for.
2. Proposed, light: here; here + ready; here + blocked elsewhere; here + not in sprint; here + Manual;
   here + run disposition; here + selected; here + hovered.
3. The same, dark.
4. Every `data-style`, light, the here card hovered.
5. Every `data-style`, dark.
6. Zoomed out: 100%, 60%, 45%, 30%.
7. Alternatives weighed and rejected (the corner pin is drawn; the in-card row is measured, not drawn).
8. The onboarding `StationCard`, unchanged.
9. Chinese (zh), light and dark.
10. Portuguese, the longest of the eleven strings, hovered, warm-editorial and neo-brutalism.

### The tab

- **Where:** hung on the card's **top edge, left**, as a sibling of the frame inside the shell's
  `relative` wrapper (the same seam the next-action button uses, so it is outside `overflow-hidden`
  and outside the fixed `NODE_W × NODE_H` footprint). It sits in the 72px row gap (`GAP_Y`), so
  `NODE_H` and the layout are untouched.
- **Classes:** `absolute bottom-[calc(100%-1px)] left-3 z-10 inline-flex h-5 items-center gap-1
rounded-t-(--radius-badge) bg-(--el-accent) px-(--spacing-chip-x-6) text-[11px] leading-none
font-semibold whitespace-nowrap text-(--el-accent-text)`.
  - `bottom-[calc(100%-1px)]`: the tab's bottom overlaps the frame's 1px top border, so on the accent
    frame the tab and the border are one shape, a folder tab.
  - `left-3` (12px): the mirror of the next-action button's `right-3`, and clear of the card's corner
    radius in every style.
  - `h-5` (20px — heights of 24px and under stay raw), `text-[11px]` and a 12px glyph: the tag row's
    one chip size (MOTIR-10508).
  - `rounded-t-(--radius-badge)` and `px-(--spacing-chip-x-6)`: the chip's own shape tokens, so a
    style swap reshapes it (square under neo-brutalism and swiss-minimal-flat, round under
    soft-playful). The bottom corners stay square because they join the frame.
  - **No shadow.** Under neo-brutalism the card's hard offset shadow belongs to the frame; a second
    offset block on a 20px tab reads as a loose chip, not part of the frame (panels 4, 5).
- **Content:** `MapPin` (`size-3`, `aria-hidden`) and the shipped `roadmap.canvas.node.here` string.
  No new copy. It never truncates and never drops to its glyph: the give-way rule no longer touches it.
- **Colour:** `--el-accent` fill, `--el-accent-text` ink: the accent fill/ink pair the primary button
  uses, so it is AA in all twenty palette × theme combinations by the palette author's own contract.

### What stays as it is

- The accent frame (`border-(--el-accent) bg-(--el-surface) shadow-(--shadow-card)`),
  `aria-current="step"` on the frame and `data-node-state="here"`.
- The frame precedence: blocked elsewhere > You are here > Done > To plan > Ready > not in sprint.
  Under blocked, the danger frame keeps the border and the tab stays accent (panel 2): both facts are
  true and both show.
- The give-way rule, exactly as it reads: a right-hand text tag drops the status slot and the Manual
  chip to glyphs. What changes is what sits in that slot.

### What changes in the status slot

The slot is the status again on the here card: `statusSlotOf(item, { ready, blocked })` with no
`here` argument, so it answers status / Done / To plan / Ready by the shared rule
(`lib/workItems/statusSlot.ts`, MOTIR-10534) like every other card. The `slotOverride` prop is no
longer passed from `WorkItemNode`; `HerePill` is deleted. (`statusSlotOf`'s `here` parameter and the
`'here'` member of `StatusSlotKind` then have no caller; MOTIR-10630 removes them with the pinned
tests.) Under here + ready the slot shows the Ready pill; the Ready mint wash stays suppressed because
here wins the frame.

### Clearances, measured in the mock

| between                                                | worst case                                                                                   | result        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------- |
| the tab and the hovered next-action button (same card) | pt `Você está aqui` (tab 12→118px) vs `motir review` under neo-brutalism (button from 133px) | 15px clear    |
| the same, en                                           | tab 12→107px vs button from 133–135px                                                        | 25–29px clear |
| the tab and the selected card above's View / Open slot | slot reaches 14px into the 72px gap; tab takes the top 20px                                  | 38px clear    |
| the tab and a single edge entering the top             | the router lands one top entry at t = 0.5 (140px)                                            | clear         |

`motir review` is the widest next-action face (the verb is mono and untranslated); Plan, `motir run`,
`motir fix` and `motir guide` are narrower.

**Two or more edges entering the here card's top.** `routeEdges` (`lib/planning/canvasGeometry.ts`)
fans several entries on one side across t = 0.28–0.72, so the first lands at 78px, under the tab. For
the here card's TOP side only, MOTIR-10630 starts that band at t = 0.5 (140px) instead, so every
arrowhead stays clear of the widest tab (118px). Every other side and every other card keep the shipped
band.

### Selected

The selection ring (`ring-2 ring-offset-2`, on the canvas node wrapper) passes under the tab, which is
painted above it; the action slot stays centred on the bottom edge. Nothing on the top-left edge
competes (panel 2).

### Zoomed out

The canvas has no level-of-detail switch: the world transform scales every card whole, from 2× down to
`MIN_SCALE` 0.3 (`lib/planning/canvasGeometry.ts`). **The tab stays as it is and scales with the card.**
Below about 60% its words stop being legible, as the status pill's do; what carries "here" then is the
solid accent block on the card's top-left edge plus the accent frame, the only filled block in that
position on any card, which still reads at 30% (panel 6). Collapsing to the pin glyph would need a
zoom-dependent render the canvas has for no other element, and would save nothing at that size: the
block is the signal, not the glyph inside it. Locate snaps to the here card at a readable zoom.

### Alternatives weighed

- **An extra top row inside the card — rejected.** The title's last line ends at 103px in the 124px
  box (MOTIR-10508), so a 20px row inside the frame costs a title line (three lines become two), and
  the layout spaces rows by `NODE_H`, so growing one card is not available.
- **A pin badge on the top-left corner only — rejected** (drawn in panel 7). Legible zoomed out and
  costs no width, but it is a glyph with no words, and "you are here" is the orientation cue for a
  reader who has just arrived; it also sits on the card's corner, which every style draws differently.
- **The tab — chosen.** It keeps the words, costs nothing inside the card, and frees the status slot.

### The onboarding station card

`StationCard` (`components/onboarding/StationNode.tsx`) **stays as it is.** Its You are here is a
state pill in its own bottom-right footer row; it displaces nothing, because a station has no status
slot and no fixed height. It already speaks the same language (map-pin, the words, the accent border
on the card), so the two read as one cue (panel 8).

### Accessibility

- The tab is rendered **before** the frame in the DOM and is not `aria-hidden`, so its words are read
  first, as the pill's were; `aria-current="step"` on the frame stays the semantic.
- The state is never colour alone: the frame colour, the tab's glyph and its words.

### Implementation notes for MOTIR-10630

- `WorkItemCardShell` gains a `tab?: ReactNode` slot rendered as the first child of the
  `group/node relative` wrapper. `WorkItemNode` passes `tab={here ? <HereTab /> : null}` and drops
  `slotOverride`.
- `PlanItemNode` passes no tab (a proposal is never "here"), so it renders exactly as before.
- `routeEdges` takes the here card's id (or a per-rect flag) to start its top-side band at t = 0.5.
- The tests that pin the old pill (`HerePill`, the here slot in `statusSlotOf`, the slot-override
  path) move to the tab.

### Out of scope

The hovered next-action button already overlaps the tag row's chips by 1–3px in every style (more
visibly under neo-brutalism's offset shadow); it predates this card and is filed as **MOTIR-10631**.

### How the asset was produced

Every card is the shipped `WorkItemNode` rendered headless through `renderMock`: panel 1 from `main`
as it is, the other panels from a throwaway copy patched only as § _Implementation notes_ says. The
generator was bundled with esbuild, run once and deleted before the commit; the selection slot and the
canvas slice's edges are static drawings of `ProjectRoadmapCanvas`'s and `PlanningCanvas`'s own markup
at the layout's real spacing.
