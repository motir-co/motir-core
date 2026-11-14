# `design/ai-planning/` — design notes

This area holds the surfaces where a person reviews what Motir's planner PROPOSES.

| Surface                                         | Files                                                     | Card                 | Section     |
| ----------------------------------------------- | --------------------------------------------------------- | -------------------- | ----------- |
| The Plans surface                               | `plans-surface.mock.html` + `.png`                        | MOTIR-843 (7.4.1)    | Part I      |
| AI **sprint** planning                          | `sprint-planning.mock.html` + `.png`                      | MOTIR-1749 (7.13.11) | Part II     |
| **Who authored a plan**                         | `plans-surface.mock.html` (panel A2) + `.png`             | MOTIR-2985           | Part III    |
| **The status tag's place**                      | `plans-surface.mock.html` (the header gallery) + `.png`   | MOTIR-3074           | Part IV     |
| A proposal on its parent's **roadmap level**    | `plans-surface.mock.html` (panel E) + `.png`              | MOTIR-3082           | Part V      |
| A proposal **READ view**                        | `plans-surface.mock.html` (panel F) + `.png`              | MOTIR-3082           | Part V      |
| A **decided** plan's node treatments            | `plans-surface.mock.html` (panel G) + `.png`              | MOTIR-3159           | Part VI     |
| What the pane holds **after approve**           | `plans-surface.mock.html` (panel H) + `.png`              | MOTIR-3159           | Part VI     |
| The Plans list **tabbed by status**             | **`plans-tabbed-list.mock.html`** + `.png`                | MOTIR-3233           | Part VII    |
| The plan detail's **List ↔ Canvas** switcher    | **`plan-detail-list-view.mock.html`** + `.png`            | MOTIR-3234           | Part VIII   |
| What a **generating** plan offers               | **`plan-detail-list-view.mock.html`** (panel 4) + `.png`  | MOTIR-3234           | Part VIII   |
| The plan canvas **at arrival**                  | **`plan-canvas-arrival.mock.html`** + `.png`              | MOTIR-3259           | Part IX     |
| **Show changes** on the plan canvas             | **`plan-canvas-arrival.mock.html`** (panels 3–4) + `.png` | MOTIR-3259           | Part IX     |
| The timeline's **CONTENT events**               | **`plan-timeline-content-events.mock.html`** + `.png`     | MOTIR-3534           | Part X      |
| The **FIFTH plan status** on every surface      | **`plans-tabbed-list.mock.html`** (panels 4–6) + `.png`   | MOTIR-3577           | Part XI     |
| **Revising a plan under review**                | **`plan-revision.mock.html`** + `.png`                    | MOTIR-3597           | Part XII    |
| **The plan detail, refined**                    | **`plan-detail-refined.mock.html`** + `.png`              | MOTIR-4017           | Part XIII   |
| **The shipped peek in PROPOSAL mode**           | **`peek-proposal-mode.mock.html`** + `.png`               | MOTIR-4182           | Part XIV    |
| **The PROPOSED to-do list in the peek**         | **`peek-proposed-todos.mock.html`** + `.png`              | MOTIR-4615           | Part XV     |
| **The grouped non-epic roots on a plan canvas** | **`plan-canvas-grouped-roots.mock.html`** + `.png`        | MOTIR-4773           | Part XVI    |
| **A proposal FILED into a folder**              | **`plan-folder-placement.mock.html`** + `.png`            | MOTIR-5406           | Part XVII   |
| **Folders as LEVELS on the planning canvases**  | **`plan-folder-levels.mock.html`**                        | MOTIR-5793           | Part XVIII  |
| **A card MOVED under a proposed parent**        | **`plan-review--surgical-edits.mock.html`**               | MOTIR-6053           | Part XIX    |
| **A leaf's DIFFICULTY on the plan review**      | **`plan-review--difficulty.mock.html`**                   | MOTIR-6134           | Part XX     |
| **The surface's List \| Canvas for a plan**     | **`plan-review--surface-views.mock.html`**                | MOTIR-6184           | Part XXI    |
| **Approve or decline a plan, in place**         | `plan-review--decide.mock.html` (on the design result)    | MOTIR-6033           | Part XXII   |
| **The plan drawn as it is written**             | **`plan-review--live-drawing.mock.html`**                 | MOTIR-6294           | Part XXIII  |
| **A Plans row NAMES its refused work item**     | **`plans-sessions--seeded.mock.html`**                    | MOTIR-6206           | § at end    |
| **Approve, while it runs**                      | **`plan-review--approve-progress.mock.html`**             | MOTIR-5248           | Part XXV    |
| **A plan being written: progress and cues**     | **`plan-review--live-progress.mock.html`**                | MOTIR-7821           | Part XXVI   |
| **A plan resumed after a lost machine**         | **`plan-review--live-progress--resuming.mock.html`**      | MOTIR-8306           | Part XXVII  |
| **Following the planner, and fields typing in** | **`plan-review--follow-the-planner.mock.html`**           | MOTIR-8591           | Part XXVIII |
| **A card's text as it is written, in the peek** | **`peek-proposal-mode--being-written.mock.html`**         | MOTIR-11196          | Part XXIX   |
| **Follow the writing, in the peek**             | **`peek-proposal-mode--follow-the-writing.mock.html`**    | MOTIR-11249          | Part XXX    |
| **The Plans page lists CONVERSATIONS**          | `plans-sessions--list.mock.html` (on the design result)   | MOTIR-6019           | by title    |
| **The list shows only what reached planning**   | **`plans-sessions--reached-planning.mock.html`**          | MOTIR-9298           | § at end    |

**A Part number is an address in THIS file.** Before taking the next number, check the area's
published design results too (`list_designs` with `pathPrefix: design/ai-planning/`): a result that
has been published but not landed here has already used its number. Part XXII records the one time
that was missed.

**And a Part is CITED by number only once it has landed here.** A design that is published but not
landed is cited by its card key and the result's own section — _MOTIR-<n>'s published design result,
§<m>_ — never as "Part <N>", because that number belongs to the result and this file may meanwhile
give it to a different Part. When the design lands, move its citations to the Part it landed as. (The
case this comes from: MOTIR-6033's result called itself Part XX, MOTIR-6134's difficulty design took
Part XX here, and a citation of "Part XX §20.2" for `planVia` resolved to the difficulty design —
MOTIR-6192.)

Both review the same way — nothing is real until approve, and the approve CTA names what it
will create. Part II mirrors Part I's grammar deliberately; it does not invent a second one.
Part III **amends Part I's asset in place** — it adds one meta entry, carrying the plan's REQUESTER
and its AUTHOR, to a shipped row and a shipped header, and redraws nothing.
Part IV amends the same asset again, and is the one place either amendment MOVES a shipped
element: the review rail's status tag leaves the title's line for its own.

## ⚠️ A design result is a MOMENT — a new surface gets a NEW asset (Yue, 2026-08-20)

**Parts III–VI amended `plans-surface.mock.html` IN PLACE and re-exported its PNG each time. Part
VII stops doing that, and the earlier Parts are not a precedent to follow.**

A design asset records the moment it was drawn, the way a commit does. Amending it for every later
surface has three costs, and the third is the one that matters:

1. **The export stops being reviewable.** By Part VI the board was 14 950px tall; adding one panel
   took it past 20 000. The design RESULT published onto the card — the thing a reviewer actually
   opens — was then fifteen screens of already-approved work with the new surface somewhere inside
   it. _"I only need to see the new tabbed list design."_
2. **Every amendment re-exports pixels nobody changed.** A binary diff of a 20 000px PNG says
   nothing about what moved, so the one guard that could catch an accidental change to an older
   panel cannot.
3. **It reads as though the old design were still current.** It is not: `plans-surface.mock.html`
   is what MOTIR-843 / 2985 / 3074 / 3082 / 3159 decided, on the days they decided it, and the
   product has moved since. Re-exporting it every time quietly claims otherwise.

**So: a NEW surface gets a NEW `<surface>.mock.html` + `.png`, and the older assets are left
frozen.** What stays shared is `design-notes.md` — one per area, indexing that area's surfaces, and
the right home for a decision that AMENDS an earlier Part's rule (§3 below reverses Part III §3;
the reversal belongs in the notes precisely because the asset it corrects is frozen).

Where a new asset reproduces rows or elements from an older one so the two are diffable, it says so
and cites the file — it does not re-render the original.

**This does NOT retroactively re-cut Parts III–VI.** Those panels stay where they are; splitting
them now would re-export the very asset this rule exists to leave alone.

**Part V amends it again** — two panels on the plan DETAIL surface: a proposal drawn on its
parent's roadmap LEVEL (nothing new — the shipped drill-down, with only the proposed card's style
differing), and a read view for one proposal composing the shipped quick view.

**Part IX gets its own asset too** — `plan-canvas-arrival.mock.html` decides the canvas's
BEHAVIOUR where Part VIII decided the pane's bodies: which level it arrives at, the breadcrumb crumb
for a parent that does not exist yet, and a **Show changes** control. It also carries the conditional
DEFAULT-VIEW rule Part VIII defers to it, and RELEASES the pane-header slot Part VIII reserved.

**Part VIII gets its own asset too** — `plan-detail-list-view.mock.html` gives the canvas pane a
header, a **List ↔ Canvas** switcher and a second body (a list of what the plan proposes) beside the
first, and draws the door for the discard valve MOTIR-3189 opened and nothing could reach. It
decides everything about the switcher EXCEPT which option is preselected, which is Part IX's
conditional rule.

**Part VII is the first Part with its OWN asset, and the first to REVERSE a rule this area
records.** `plans-tabbed-list.mock.html` tabs the list by status, draws the two different
emptinesses tabs create, restores the requester to a decided row beside the decider Part III kept
(and nobody ever built), and takes the page header's duplicate Plan-with-AI pill away.
**It does not amend `plans-surface.mock.html`** — see _A design result is a MOMENT_ below.

**Part VI amends it once more, and is the first Part to draw the state AFTER the decision** — the
accepted / declined node treatments (a fourth axis CROSSING the three `op` languages, not a fourth
member of them), and the answer to what the canvas pane holds once a plan is approved. That second
half re-opens a shipped decision on the record: MOTIR-1775 / MOTIR-1782 decided the establish step
REPLACES the canvas; Part VI §4 decides it STACKS above it, and says why.

---

# Part I — The Plans surface — design notes (MOTIR-843 / 7.4.1)

> **This design COMPOSES four already-shipped surfaces and adds ONLY the Plans-substrate
> chrome.** It is NOT a bespoke tree editor and NOT a re-draw of the planning canvas, its
> edges, zoom, search, drill-down, or the canvas+chat review. Per `notes.html` mistake **#82**
> ("a design that COMPOSES an already-designed sub-surface must ground in that sub-surface's
> shipped asset and say so — a design whose prose reads as re-drawing a pane another done
> design owns will be built twice") and **#64** (a design that changes only the chrome, not the
> interaction model, must reuse the shipped model), the only new pixels here are the
> Plans-substrate chrome listed in §3.

## 1. The four shipped references this composes (cited per the acceptance criteria)

The card names these with their planning aliases; the **real shipped assets / components** are
the ground truth (rung 2 — shipped reality outranks card prose). All four were read on disk in
PR **#1398** (MOTIR-1194, the canvas implementation, in review) and on `main`:

| Card alias                                                                                 | Real shipped asset / component                                                                                                | What it owns — NOT re-drawn here                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-1193** — "the canvas+chat workspace shell" (`design/ai-chat/planning-workspace.*`) | `design/ai-chat/canvas-spatial.*` + `onboarding.*`                                                                            | The ONE shared planning interface: canvas-left + chat-rail-right, the on-canvas one-by-one proposed placement, confirm-to-persist. **Generation-review is a MODE of this shell.**                                                               |
| **MOTIR-1009** — "the standalone canvas DESIGN"                                            | `design/roadmap/` (`roadmap.mock.html`, `edges.mock.html`, `grid-init.mock.html`)                                             | The tree (epic→story→subtask), within-story vs cross-story dependency edges, zoom / zoom-to-fit, search-to-focus, drill-down, virtualization, node / empty / loading states, the on-canvas dependency legend + cross-story ghost-anchor signal. |
| **MOTIR-1194** — "the canvas COMPONENT (`WorkItemCanvas`)"                                 | `components/planning/ProjectRoadmapCanvas.tsx` + `PlanningCanvas.tsx` + `WorkItemNode.tsx` + `PlanPreview.tsx` (PR **#1398**) | The **presentational** canvas: fed forest + edges as DATA, owns no fetching. The plan detail FEEDS it the plan's `PlanItem`s as data — the proposed tree is just another data input to the same canvas, NOT a second canvas.                    |
| **MOTIR-1010** — "the per-level READ"                                                      | the per-level roadmap read (`app/api/projects/[key]/roadmap/route.ts` + `lib/planning/projectCanvasModel.ts`, PR **#1398**)   | The canvas is per-level **DRILL-DOWN, not whole-tree** (finding #91). The proposed tree renders PER LEVEL (drill epic→story→subtask); a `modify`/`remove` diff overlays the EXISTING per-level committed tree with the plan's changes on top.   |

**This design does NOT redesign the canvas, the canvas+chat review, the dependency edges, zoom,
search, or drill-down.** Those ship from 1009/1194/1010 and are mounted as-is. Where this doc
shows the canvas, it embeds the **real shipped markup** from `design/roadmap/` and the
`ProjectRoadmapCanvas` / `WorkItemNode` / `PlanPreview` components — not a stylized stand-in (the
MOTIR-1196 / 7.2.1 lesson: show/reuse the real shipped UI, never a redrawn copy).

## 2. The model this renders (Story 7.21 — the Plan substrate, MOTIR-1336/1337)

A **`Plan`** is a reviewable bundle of proposed **`PlanItem`** operations. Nothing is real until
**approve**; on approve the PlanItems **materialize**. There is **NO `proposed` WorkItem status**
and **NO "Discard"** — proposals never enter the tree, ready-set, board, or dispatch.

- **`Plan.status`**: `generating → planned → approved | declined`, **plus `stale`** — see
  **Part XI**, which SUPERSEDES this line (2026-08-26). `planned → stale` when a `modify`/`remove`
  target reaches a terminal status; `stale → planned` when that drift reverses; `stale → declined`.
- **History surface** = the lifecycle timestamps + actor: `createdAt`, `plannedAt` (generation
  done), `decidedAt` + `decidedById` (approve/decline). These ARE the history timeline (no
  separate event log needed).
- **`PlanItem.op`**: `add | modify | remove`.
  - **`add`** — proposed new node; lives ONLY as a PlanItem (`workItemId` null, fields in
    `proposedFields`) until approve → create the WorkItem.
  - **`modify`** — the EXISTING target untouched; `patch` holds the sparse changed fields +
    `baseRevision`. Approve → apply patch to the **same id** (a logged revision, not a ghost copy).
  - **`remove`** — approve → **archive** the target.
- **Approve** = MATERIALIZE (add→create, modify→patch same id, remove→archive). **Decline** =
  drop the PlanItems (the tree was never touched). Identity is preserved on modify.

## 3. What 843 GENUINELY adds — the only new pixels (the Plans-substrate chrome)

Everything below is layered ON the composed shell + canvas; nothing here re-draws them.

### Panel A — the Plans LIST + left-nav "Plans" entry (a LIST, not a canvas)

The index. A left-nav **"Plans"** entry (the access path — drawn beside the other project nav
surfaces, routing to `/…/plans`). Each row: the summary/idea the plan came from, a **status pill**
(`generating` / `planned` / `approved` / **`stale`** / `declined` — the fifth SUPERSEDES this list
as of 2026-08-26, **Part XI**), the item count, when-planned, when-decided,
and a **"N may be out of date" stale flag** for a `planned` plan with drifted items. The empty
state — "Generate your first plan" CTA into the 7.3 discovery hand-off. Reuses the shipped
list/`useRowWindow` primitives — not a hand-rolled list. (Built by MOTIR-1338.)

### Panel B — the plan DETAIL = the generation-review MODE of the 1193 workspace (composed)

The composed canvas+chat shell, with the Plans chrome layered on:

- **Plan status** + a **history timeline** (created / planned at X; approved or declined at Y by Z).
- **Per-item `op` treatment**, drawn ON the real `WorkItemNode`. The three ops use **three
  distinct, non-colliding visual languages**, and none of them reuses the red dashed/hatched
  language the shipped canvas already owns for **cross-story dependencies** (the `GhostAnchor` /
  cross-blocked node — danger dashed border + `danger-surface` hatch). Red-hatch stays reserved
  for that dependency signal; the op treatments are a separate axis:
  - **`add`** → **dashed ACCENT (purple) border + accent-soft tint + a "+ add" badge** — a new
    node not yet in the tree (proposed). An `add` node also carries an **Edit affordance** (a
    pencil icon-button in the node's top-right, beside where a status pill sits on other ops) —
    see the inline-edit bullet below (MOTIR-1370).
  - **`modify`** → the **EXISTING** node, **solid INFO (blue) ring + a "proposed change" badge** +
    an inline **old→new diff** (old read live from the target, new from `patch`) — SAME id, not a
    ghost copy.
  - **`remove`** → a **NEUTRAL "will be archived"** treatment (solid muted border + grey fill +
    strike-through title + an archive chip) — deliberately **not** red/dashed/hatched, since
    archive is reversible (the `cancelled`-status hue), not the error/attention signal cross-story
    deps carry. This is the fix for the original collision: `remove` previously read identically to
    a cross-level dependency.
    - **⚠️ AMENDED 2026-09-04 (MOTIR-4475) — it is no longer "dimmed, de-saturated".** The asset and
      the component both carried an `opacity` fade on the node ROOT, and CSS `opacity` composites
      the element AND its whole subtree against the backdrop: measured on the composed DOM at the
      shipped `opacity-80`, the title, the identifier and the status pill all read **3.95:1** over
      the board's `--el-canvas` and the op badge **3.98:1**, under AA's 4.50 — and every one of them
      survived MOTIR-4260's re-inking of the title, because opacity scales whatever ink you pick.
      That is MOTIR-2495's rule at a second site (_"no ink choice can fix it"_), and its remedy is to
      carry the state as COLOUR. **Nothing is lost:** the strong border, the muted fill and the
      strike are three channels already, and PENDING vs DECIDED is carried by the two signals a
      decided node ADDS — the outcome spine and the outcome segment on its op chip — which is how
      `add` and `modify` distinguish the same two states without dimming anything.
      `tests/components/composed-surface-ink.test.tsx` mounts the pending node on its own
      `--el-canvas` board and measures the composite, in both themes.
- **Inline edit of a proposed `add`** (MOTIR-1370). The Edit pencil on an `add` node opens a
  **Modal** edit form over the add's proposed fields — **Title** (`Input`), **Type** (the kind
  picker `TypePicker`), **Work type** (`WorkItemTypePicker`), **Priority** (`PriorityPicker`),
  **Description** (`Textarea`) — Save / Cancel in the footer. The same field controls the
  create-issue modal uses, so the form needs no new primitive. Editing patches the PlanItem's
  `proposedFields`; **no WorkItem is created** (an `add` stays a proposal until approve), and on
  save the canvas refetches the review model and re-renders. **Only an `add` is editable** —
  `modify`/`remove` target existing items, so they carry no Edit affordance. The trigger and the
  form are offered **only while the plan is `planned`**; a decided plan is read-only.
- The decision gate: an **Approve** primary — **"Add N items to your backlog"** (→ MATERIALIZE),
  with a stale-warning confirm when items are stale — and a **Decline** secondary (drop). A
  decided plan is **read-only** with its outcome + history shown. (NO "Discard"; Approve =
  materialize, Decline = drop.) (Built by MOTIR-847.)

### Panel C — live generation

The streaming **"Generating your plan…"** state: proposed nodes appear **PER LEVEL** on the
composed canvas as the engine emits PlanItems (respecting drill-down — NOT a whole-tree reveal);
`aria-live` announces progress. Reads the substrate's own Plan data (poll/refresh `getPlan`), so
7.21 never depends on the 7.4 generation stream.

### Panel D — terminal states

- **Empty** — no direction docs yet → link the 7.3 discovery chat (MOTIR-833).
- **Failed** — retry; a partial proposed frontier is discardable.
- **Out of credits** — "You're out of planning credits" + top-up CTA into 6.10 (generation is
  metered — 7.2).

## 4. Tokens, primitives, a11y

- **Tokens only**: `--el-*` element/semantic tokens + the element-semantic **shape** tokens,
  driven by the top-level `[data-display-style]` attribute. **No Tier-0 `--color-*`, no raw
  `rounded-md`/`p-2`/`h-9`.** The proposed tint, the "will be archived" treatment, and the stale
  badge all route through the semantic intent tokens (accent / warning / danger), not hand-picked
  hex.

  > **⚠️ AMENDED 2026-09-03 (MOTIR-4348) — this bullet was stated here and NOT held by the asset,
  > and nothing could measure the gap.** `plans-surface.mock.html` declared **no `--el-*` custom
  > property at all**: its `:root` copied the design system's light values onto PRIVATE names —
  > `--text`, `--strong`, `--secondary`, `--muted`, `--faint`, `--page`, `--surface`, `--soft`,
  > `--hub`, `--hair`, `--mutedfill`, `--t-*` — and painted 397 sites through them.
  >
  > **Why that is not cosmetic.** Both ink guards classify ink by reading an `--el-*` name off the
  > declaration **at the paint site** (the resting arm, and the state arm added by MOTIR-4255). A
  > privately-named alias is invisible to them however faithfully its value is copied, so this
  > asset — the largest mock in the tree — sat outside every ink guard by construction, and their
  > tree-wide greens said nothing about it.
  >
  > **And "not hand-picked hex" was FALSE.** The `:root` carried six hues with no token twin, and
  > fifty more raw literals sat at points of use, outside any alias. Each is now a token or a
  > `color-mix()` whose inputs are all tokens; the table is in the pull request for MOTIR-4348.
  >
  > **The swap exposed 59 sub-AA elements** the asset had been carrying unmeasured — 19 painting
  > `--el-text-muted` on a tinted surface, 40 painting `--el-text-faint`, which clears AA on no
  > surface at all. Eighteen rules and two inline styles now take `--el-text-secondary`.
  >
  > **The drawing did not move.** Layout, copy, elements and access paths are unchanged; only the
  > declaration layer moved. The re-export reports the committed dimensions unchanged at
  > 2400x14950. This is a token-layer repair of a frozen asset, which the freeze rule above does
  > not forbid — that rule is about a NEW SURFACE getting a new asset, and no surface is added
  > here.

- **Composes ONLY shipped primitives** (`Card` / `Button` / status `Pill`/`Badge` /
  `SectionLabel` / `Modal` / the list row + `useRowWindow`) + the real canvas. The proposed-`add`
  edit form (MOTIR-1370) likewise composes shipped controls only — `Input` / `Textarea` /
  `TypePicker` / `WorkItemTypePicker` / `PriorityPicker` inside the shared `Modal` (the same set
  the create-issue modal uses). A genuinely new primitive would be its OWN `design/` subtask —
  none is introduced here.
- **a11y**: status pills carry **text, not colour only**; the generating state is `aria-live`; the
  canvas keyboard/zoom affordances are inherited from the composed `ProjectRoadmapCanvas` (not
  re-specified). Copy lives in the `aiPlanning` i18n namespace.

## 5. Access path

The surface is reached from the **"Plans" left-nav entry** (Panel A) → the Plans list → a row →
the plan detail (Panel B). The empty list and the onboarding hand-off (MOTIR-840) both route into
the generate entry. The nav entry is drawn in the mock so the reader SEES the door, not just the
route name (the access-path rule).

---

# Part II — AI sprint planning: the entrance, the packing review, approve / discard (MOTIR-1749 / 7.13.11)

> **Story:** MOTIR-813 · _Cadence — auto-planning + AI sprint planning_ (Epic 7).
> **Subtask:** MOTIR-1749 (7.13.11) — the design gate for **MOTIR-1750** (7.13.12), which implements
> this asset. **motir-core only.**

| File                        | What it is                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `sprint-planning.mock.html` | The asset SOURCE — six panels, built from the real design system. Layout source of truth. |
| `sprint-planning.png`       | Full-page export (light, `deviceScaleFactor: 2`, viewport 1200) — the reviewable face.    |

**The gap this closes.** MOTIR-917 ships the `plan_sprint` packing job, MOTIR-918 the API + persist
behind an approve gate, MOTIR-919 the settings toggles — and the shipped settings copy already
promises the user _“Motir proposes the next sprints from ready work; **you approve before any sprint
is created**.”_ No surface ever shipped where that approval happens. This asset draws it.

## 1. Drawn against SHIPPED reality — what was RENDERED first

The host already exists, so it was **rendered, not reasoned about** (notes.html mistake **#73** — “reading
the `.tsx` is not seeing what renders”). On `origin/main` @ `28c11c8b`: `pnpm next build` +
`next start`, signed in against a seeded tenant, full-page screenshots of **`/backlog`**,
**`/settings/project/ai-planning`** and **`/ready`** at 1280 × dSF 2. Everything below composes
those renders:

| Rendered / read source                                                                    | What this design takes from it — verbatim, not redrawn                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/(authed)/backlog/page.tsx`                                                           | The host page: serif `text-2xl` **Backlog** + muted sub **“Motir · plan & groom — rank, sprint, estimate”**; toolbar `[View all work items] [Filter] [Advanced] [Saved] [+ New work item]`.                                                                                               |
| `_components/BacklogContainer.tsx` → `CreateSprintButton`                                 | The **full-width dashed `＋ Create sprint` strip** between the sprint region and the Backlog region. This strip is where the door lands.                                                                                                                                                  |
| `_components/SprintContainer.tsx`                                                         | The sprint panel the **proposed** sprint is a variant of — chevron · name · state `Pill` · calendar range · count badge · committed points · velocity seam · Start sprint · `⋯`.                                                                                                          |
| `_components/BacklogRow.tsx`                                                              | The work-item row — grip · selection circle · `IssueTypeIcon` · mono identifier · title · `EstimateBadge` · avatar · status pill · `⋯`.                                                                                                                                                   |
| `app/(authed)/ready/_components/ExpansionNudge{Banner,Review}.tsx`                        | The **shipped in-surface AI proposal grammar**: lavender-tint `Card`, `Sparkles` in `--el-accent-on-surface`, a phase machine, **Approve** primary / **Decline** ghost. Reused.                                                                                                           |
| `app/(authed)/backlog/_components/SprintPlanDock.tsx`                                     | The **review-dock grammar**: header title + close · scrolling body · footer with the count on the left and ghost-decline / primary-approve on the right, the CTA carrying the count. Drawn from `PlanEditsReviewDock`, retired by MOTIR-4261; the sprint dock is its shipped carrier now. |
| `design/ai-planning/plans-surface.*` (Part I)                                             | The proposal-review grammar this mirrors — nothing real until approve; approve MATERIALIZES; the CTA names what it creates.                                                                                                                                                               |
| settings `/settings/project/ai-planning` (rendered)                                       | The **“Plan sprints with Motir”** switch, its promise copy, and the peach “Motir AI isn’t connected” callout shape reused for off/error.                                                                                                                                                  |
| `lib/ai/sprintAssignment.ts`, `lib/ai/types` (`SprintAssignmentDelta` / `ProposedSprint`) | Every figure rendered is a REAL field — see §4.                                                                                                                                                                                                                                           |
| `lib/services/aiSprintPlanningService.ts`, `app/api/ai/plan/sprint/**`                    | Submit (409 / 402 / 502), the SSE stream, approve (400 shape · 400 semantic · 403 sprint-admin).                                                                                                                                                                                          |

## 2. PLACEMENT — the backlog hosts it (justified from the shipped IA, not asserted)

The card offers three candidate hosts. Shipped reality picks the backlog:

1. **`/backlog` IS the sprint-planning surface.** Its own page comment: _“The Backlog /
   sprint-planning surface (Story 4.2 · 4.2.3) — Motir’s clone of the Jira backlog.”_ Sprints are
   created, filled, started and completed there and nowhere else.
2. **Approve writes exactly the two gestures this page already owns.**
   `aiSprintPlanningService.approveSprintPlan` calls `sprintsService.createSprint` (the page’s
   `＋ Create sprint` strip) and `backlogService.bulkAssignToSprint` (its drag-into-sprint / bulk
   move). AI sprint planning is the **automated form of the host’s own two gestures**, so the door
   belongs beside the manual one — not on a third surface.
3. **The settings asset explicitly disclaims it.** `design/ai-settings/design-notes.md` scopes card 2
   to `aiSprintPlanningEnabled` + `aiSprintLengthDays` and lists _“the sprint-proposal review UI —
   **its own surface**, not a settings pane”_ as out of scope. Settings CONFIGURES; the backlog RUNS.
4. **It earns NO left-nav entry.** A nav entry is this app’s convention for a first-class project
   VIEW (Dashboard / Boards / Backlog / Roadmap / Plans). This is an **action on the backlog’s own
   objects** — the same class as Start sprint and Complete sprint, which also live in-surface. Adding
   a route would fork sprint planning across two surfaces (the converse of notes.html mistake **#99**:
   a view earns a nav entry, an in-surface action does not).

### The doors, both DRAWN (panels 0 and 0b)

- **Primary — the create-sprint strip becomes a two-action strip** (panel 0). Left: the shipped
  `＋ Create sprint` (unchanged, `flex: 1`). A 1 px `--el-border-strong` divider. Right:
  **`Plan sprints with Motir`**, `--el-tint-lavender` fill + `--el-accent-on-surface` ink + the
  `Sparkles` glyph — the same treatment every other AI affordance in the app carries. The strip keeps
  its single dashed `--el-border-strong` / `--radius-card` silhouette, so the page’s rhythm is
  unchanged.
- **Secondary — the ⌘K command palette** (panel 0b): a **Backlog** group entry
  **“Plan sprints with Motir”** that navigates to `/backlog` and opens the run in one step. Registered
  in the same command registry the shipped “Go to Backlog” / settings deep links come from, so the
  action has one implementation and two doors (the notes.html **#83** lesson: don’t leave the
  cross-surface door unowned — here it is drawn AND owned by MOTIR-1750).

## 3. Panels

| #   | Panel                | What it shows                                                                 |
| --- | -------------------- | ----------------------------------------------------------------------------- |
| 0   | **Entrance**         | The rendered backlog with the two-action strip in place.                      |
| 0b  | **Second door**      | The ⌘K palette with the Backlog-group entry.                                  |
| 1   | **Off**              | `aiSprintPlanningEnabled = false` — door present and disabled + the fix hint. |
| 2   | **Generating**       | The streamed packing run, with Cancel.                                        |
| 3   | **Proposed packing** | The review — the main panel.                                                  |
| 4   | **Edge states**      | Empty packing + the four failure shapes.                                      |
| 5   | **After approve**    | The created sprints as ordinary Epic-4 sprints + the toast.                   |

## 4. The review renders REAL fields only

Every figure maps 1:1 onto `SprintAssignmentDelta` / `ProposedSprint`. Nothing is invented:

| Drawn                                    | Field                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| “3 sprints · 9 work items · 7 days each” | `sprints.length` · `itemCount` · `sprintLengthDays`                                                                   |
| Sprint name (**Sprint 2**)               | `sprints[].name`                                                                                                      |
| **7 days** chip                          | `sprints[].lengthDays`                                                                                                |
| Count badge (**4**)                      | `sprints[].itemKeys.length`                                                                                           |
| “19h 50m of 28h — 71%”                   | `sprints[].totalEstimateMinutes` / `sprints[].capacityMinutes`                                                        |
| “at 240 agent-minutes a day”             | `agentMinutesPerDay`                                                                                                  |
| **Bigger than a sprint** pill            | `sprints[].oversizedKeys` (and the head’s roll-up count)                                                              |
| **No estimate** pill                     | `unestimatedKeys`                                                                                                     |
| **Why this order** callout               | `sprints[].rationale`                                                                                                 |
| The row order itself                     | `sprints[].itemKeys` order — the packing’s dependency order, which `validatePacking` proves is blocker-before-blocked |

**One read MOTIR-1750 must ADD.** The per-row **“after MOTIR-1749”** caption is the only element not
in the delta. It comes from the `is_blocked_by` edges among the packed items — exactly the edges
`aiSprintPlanningService.validatePacking` already resolves via
`workItemLinkRepository.findBlockedByEdges`. MOTIR-1750 surfaces the same read in the review model so
the caption is server-derived, never guessed in the browser. A row with no in-packing blocker shows
nothing (absence is the default; the caption is never rendered empty).

## 5. Primitives — every element, and what it is

| Element                                 | Primitive / shipped component                                 | Notes                                                                  |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Page header, toolbar                    | `app/(authed)/backlog/page.tsx`                               | Untouched.                                                             |
| `＋ Create sprint`                      | `BacklogContainer.CreateSprintButton`                         | Untouched; becomes `flex: 1` inside the strip.                         |
| `Plan sprints with Motir` (both states) | `Button` (`variant="ghost"`, `size="sm"`) inside the strip    | Lavender fill is the strip’s, not a new button variant.                |
| Off hint                                | the shipped callout shape (`Card`-less tinted block)          | Same markup family as the settings “Motir AI isn’t connected” callout. |
| Generating dock                         | `PlanEditsReviewDock` running state + `Spinner`               | `role="status"`, `aria-live="polite"`.                                 |
| Review dock shell                       | `PlanEditsReviewDock` (header / body / footer)                | Header/footer copy differs; structure identical.                       |
| Proposed sprint                         | `SprintContainer` + the proposed treatment                    | Read-only variant — see §6.                                            |
| Proposed row                            | `BacklogRow` (`BacklogRowBody`, no `dragProps`)               | Read-only variant — see §6.                                            |
| State chips                             | `Pill`                                                        | `Proposed` · `Bigger than a sprint` · `No estimate`.                   |
| Approve / Discard                       | `Button` `variant="primary"` / `variant="ghost"`              | Mirrors the dock + the ExpansionNudge pair.                            |
| Empty packing                           | `EmptyState`                                                  | Title + description + a secondary Close.                               |
| Failures                                | the tinted callout + a `Button variant="secondary" size="sm"` | One per status code (§7).                                              |
| Success                                 | `Toast` (`variant="success"`)                                 | Via the shipped `useToast`.                                            |
| ⌘K entry                                | `CommandPalette` registry entry                               | No new primitive.                                                      |

**No new primitive is introduced.** Anything that looks new is a composition of the above.

## 6. The PROPOSED treatment (the only genuinely new pixels)

A proposed sprint is the shipped `SprintContainer` with three changes, and three removals:

- **Border** → `1px dashed var(--el-accent)` (a real sprint is `1px solid var(--el-border)`).
- **Head fill** → `var(--el-tint-lavender)`, `border-bottom` `--el-accent`.
- **State pill** → `Pill` reading **Proposed**. On the lavender head it flips to
  `background: var(--el-page-bg)` + `color: var(--el-accent-on-surface)` — a lavender chip on a
  lavender head is not a chip. Both are palette tokens; no hue is invented.
- **Removed:** the drag grip, the selection circle, the row `⋯`, the sprint `⋯`, and **Start sprint**.
  A proposal has no lifecycle; those controls appear only once the sprints are real (panel 5).
  (The blue check-square that remains on each row is the **`IssueTypeIcon` for a task**, not a
  checkbox — same glyph the shipped backlog row renders.)
- **Added:** the capacity line and the **Why this order** callout (below).

**Deliberately NOT reused:** the canvas’s dashed-danger / hatched language, which is reserved for
cross-story dependency signalling (Part I §3). Proposed is accent-dashed; over-capacity is warning;
a refusal is danger. Three separate axes.

**Editing a proposal is out of scope for this release.** The approve API accepts an edited delta
(`approvedDelta`), so the seam exists — but v1 approves or discards **whole**, and re-running is how
you get a different packing. Drawing an editor here would design a surface no card owns.

## 7. Copy — every string (i18n namespace `backlog.aiPlan.*`)

The host page already uses the `backlog` namespace; these keys join it under an `aiPlan.` prefix, the
same way `/ready` nests its AI banner under `ready.nudge.*`. **Every new `en.json` key needs its
`zh.json` twin in the same PR** (the i18n-catalog parity gate).

**Entrance / off**

- `aiPlan.cta` — **Plan sprints with Motir**
- `aiPlan.offTitle` — **AI sprint planning is off for this project.**
- `aiPlan.offBody` — **Turn it on to let Motir pack your ready work into short, dependency-aware sprints.**
- `aiPlan.offLink` — **AI planning settings**
- `aiPlan.commandLabel` (⌘K) — **Plan sprints with Motir**

**Generating**

- `aiPlan.runningTitle` — **Planning your sprints…**
- `aiPlan.cancel` — **Cancel**
- `aiPlan.stepRead` — **Read {count} ready work items and what blocks what**
- `aiPlan.stepSize` — **Sized them against a {days}-day sprint at {minutes} agent-minutes a day**
- `aiPlan.stepPack` — **Packing sprint {n} of {total}…**
- `aiPlan.stepDone` — **done**

**Review**

- `aiPlan.reviewTitle` — **Proposed sprints**
- `aiPlan.reviewSub` — **{sprints} sprints · {items} work items · {days} days each — nothing is created until you approve.**
- `aiPlan.proposed` — **Proposed**
- `aiPlan.lengthDays` — **{days} days**
- `aiPlan.capacity` — **{used} of {total} — {pct}% of a {days}-day sprint at {minutes} agent-minutes a day**
- `aiPlan.capacityOver` — **{used} of {total} — over by {over}, held together because {key} blocks the rest**
- `aiPlan.firstSprint` — **first — nothing blocks it**
- `aiPlan.after` — **after {key}**
- `aiPlan.oversized` — **Bigger than a sprint**
- `aiPlan.oversizedCount` — **{count} bigger than a sprint**
- `aiPlan.unestimated` — **No estimate**
- `aiPlan.whyLabel` — **Why this order.**
- `aiPlan.approveFine` — **Approving creates these sprints and moves the work items into them. Nothing else changes — no status moves, no sprint starts.**
- `aiPlan.discard` — **Discard**
- `aiPlan.approve` — **Create {count} sprints**

**Empty / failures / success**

- `aiPlan.emptyTitle` — **Nothing to schedule**
- `aiPlan.emptyBody` — **Every work item that could go into a sprint is already in one. Motir will have something to pack once new work is ready, or once this sprint completes.**
- `aiPlan.close` — **Close**
- `aiPlan.errDisabled` — **AI sprint planning is off for this project.** _(+ “Nothing was created.”)_ → 409 `SPRINT_PLANNING_DISABLED`
- `aiPlan.errCredits` — **You’re out of planning credits.** Top up to keep Motir planning your sprints. → 402
- `aiPlan.errUnreachable` — **Motir didn’t answer.** Nothing was created — try again in a moment. → 502
- `aiPlan.errPacking` — **This packing no longer fits your plan.** {detail} Nothing was created. → 400 (`SPRINT_ASSIGNMENT_INVALID` / `SPRINT_PLAN_APPROVE_ERROR`)
- `aiPlan.errNotAdmin` — **You need sprint-admin rights on this project to create sprints.** → 403 `NotSprintAdminError`
- `aiPlan.retry` — **Try again** · `aiPlan.planAgain` — **Plan again** · `aiPlan.topUp` — **Top up**
- `aiPlan.doneTitle` — **{count} sprints created**
- `aiPlan.doneBody` — **{items} work items moved into {names}.**

Every failure states **nothing was created** — true by construction: approve runs in ONE
`withWorkspaceContext` transaction, so a partial write cannot happen, and the copy may promise it.

## 8. Token roles — colour (`--el-*`) and shape

**No raw hex, no `rgb()`, no Tier-0 `--color-*`, and no raw `rounded-*`/`p-*`/`h-*` anywhere in the
mock or the implementation.**

| Element                                                       | Colour token                                                                        | Shape token                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Page title / body ink                                         | `--el-text`                                                                         | —                                                         |
| Sprint name, chip ink, callout lead                           | `--el-text-strong`                                                                  | —                                                         |
| Secondary copy, ghost button ink                              | `--el-text-secondary`                                                               | —                                                         |
| Capacity line, count badge ink, footer fine print             | `--el-text-muted`                                                                   | —                                                         |
| Velocity seam, drag grip, avatar dash                         | `--el-text-faint`                                                                   | —                                                         | — faint is correct here: the grip and the avatar dash are `aria-hidden` glyphs. |
| Strip + panel borders                                         | `--el-border` · `--el-border-strong` (dashed strip) · `--el-border-soft`            | `--radius-card`                                           |
| AI door fill / dock head / Proposed chip on white             | `--el-tint-lavender`                                                                | `--radius-card` · `--radius-badge`                        |
| AI door ink, Sparkles glyph, ⌘K active row                    | `--el-accent-on-surface`                                                            | —                                                         |
| Proposed sprint border, review-dock border, insertion accents | `--el-accent`                                                                       | `--radius-card`                                           |
| Approve CTA fill / its ink                                    | `--el-accent` / `--el-accent-text`                                                  | `--radius-btn` · `--height-btn-md`                        |
| Capacity bar track / fill                                     | `--el-muted` / `--el-accent`                                                        | `--radius-badge`                                          |
| Capacity bar OVER capacity                                    | `--el-warning`                                                                      | `--radius-badge`                                          |
| Over-capacity + unestimated chips                             | `--el-warning-surface` + `--el-warning-text` · `--el-tint-sky` + `--el-text-strong` | `--radius-badge` · `--spacing-chip-x/y`                   |
| Off hint, fixable failures (disabled / credits)               | `--el-warning-surface` + `--el-warning-text`                                        | `--radius-card`                                           |
| Refusals (unreachable / invalid packing / not admin)          | `--el-danger-surface` + `--el-danger-surface-text`                                  | `--radius-card`                                           |
| Success toast glyph                                           | `--el-success`                                                                      | `--radius-card` · `--shadow-elevated`                     |
| Row hover / status pill                                       | `--el-surface-soft` · `--el-tint-lavender`                                          | `--radius-control` · `--spacing-control-x/y`              |
| Links (settings, create-work-item)                            | `--el-link`                                                                         | —                                                         |
| Card / dock elevation                                         | —                                                                                   | `--shadow-subtle` · `--shadow-card` · `--shadow-elevated` |

> ⚠️ `--el-danger-text` is **fill ink** (it resolves to `--color-destructive-foreground`, i.e. white),
> NOT a label colour for a light surface. Danger copy on a surface uses
> `--el-danger-surface` + `--el-danger-surface-text`, or `--el-danger` as the ink. The mock uses the
> pair everywhere.

Colour is never the only signal: **Proposed**, **Bigger than a sprint**, **No estimate** and every
failure all carry text (the a11y rule Part I §4 states).

## 9. a11y

- The review dock is a `<section aria-labelledby>` with the **Proposed sprints** heading; the
  generating state is `role="status" aria-live="polite"` (as `PlanEditsReviewDock` already does).
- Each proposed sprint is a `<section aria-label="{name}, proposed, {count} work items">` — mirroring
  `SprintContainer`’s `sprintRegionLabel`.
- The proposed rows are a `role="list"` of `role="listitem"`, **not** the sortable `role="row"` grid —
  they are not draggable, and claiming row semantics for a static list would mislead (the
  listbox-row-actions lesson).
- The failure callouts are `role="alert"`; the success is the shipped `Toast` (already announced).
- Focus after approve moves to the first created sprint’s header, so a keyboard user lands on the
  result rather than on a removed dock.

## 10. Page state after the mutation (the enforced contract — CLAUDE.md)

Approve touches **two** surfaces on `/backlog`, and they update differently:

1. **The sprint region** — `BacklogContainer` is a **client island** that seeds `useState` from its
   own `/api/sprints` fetch. `router.refresh()` **cannot** reach it. Approve must call the island’s
   existing refetch (`reloadKey` bump — the same signal `CreateSprintButton`’s `onCreated` and
   `SprintContainer`’s `onStarted` / `onDeleted` already use).
2. **The Backlog region** — the approved items LEAVE it, so its `useRankedIssues` read must refetch in
   the same update (the `issuesRefreshKey` tick, exactly as a completed sprint’s carry-over does).

Both are already-shipped signals; MOTIR-1750 wires approve to them and adds no third mechanism. The
dock unmounts on success — it must not linger showing a proposal that has become real.

## 11. Explicitly OUT of scope here (so no one builds it twice)

- **Editing a proposed packing** (move an item between proposed sprints, rename, re-size). The
  `approvedDelta` seam exists; the UI is a later card if it is ever wanted.
- **Sprint dates.** `approveSprintPlan` deliberately leaves the window unset — the shipped
  `startSprint` stamps it. So the proposal shows a **length**, never a calendar window, and the
  created sprints read **Not started** (panel 5).
- **The cadence-fired path.** MOTIR-916’s sweep may submit the same job unattended; where its result
  is surfaced is that card’s question, not this surface’s. This asset covers the **person-initiated**
  run. (Both land on the same approve gate, so a later card can mount this same dock.)
- **The settings pane** — MOTIR-914 / MOTIR-1739 own it (`design/ai-settings/`).

---

# Part III — Who ASKED for this plan, and who WROTE it (MOTIR-2985 / Story MOTIR-2982)

**Amends Parts I and II's asset in place**: the same three files
(`design-notes.md` · `plans-surface.mock.html` · `plans-surface.png`), one new panel — **A2**.

## 0. The premise — a plan has THREE parties

A plan is produced by up to three different people, and the surface recorded only one of them:

| axis             | question                                      | recorded before this                                                      |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| **Requested by** | which PERSON asked for this plan              | **nothing at all**                                                        |
| **Written by**   | which agent (or Motir) produced the proposals | nothing at all                                                            |
| **Decided by**   | which person approved / declined it           | `Plan.decidedById` ✓ (drawn in panel A as _"approved yesterday by Mara"_) |

**The requester is the one a reviewer wants first**, and an agent-authored plan makes that question
sharper rather than softer. _An agent_ is not an answer to _whose plan is this?_ — **the MCP token
belongs to a person**, who minted it and pointed it at this project, and a Motir generation was
**clicked** by a person. A surface that named only the agent would read as though nobody is
accountable for a tree somebody is about to approve, which is a worse failure than the one the
attribution was added to fix.

So the attribution names **the person first and the agent second**, in one entry, as one sentence
about provenance.

## 1. What is UNCHANGED — composed, not redrawn

- **The access path.** Plans is reached from the left-nav _Plans_ entry (Part I §5), and a row is a
  single `<Link>` into `/plans/[id]` — `PlanRow.tsx` says so in its own header. **No new door.**
- **The row's shape**: the 22px status icon-square, the title line, the meta line, the right-hand
  pill cluster, the accent border on a `planned` row awaiting review.
- **The status pills** and their tones, and the rule that status is carried by TEXT, not colour alone.
- **The staleness flag**, **the plan-detail canvas, the history timeline, and the approve / decline bar.**

## 2. Drawn against SHIPPED reality — what was RENDERED first

The list row is already implemented, so this was drawn against pixels rather than source. The **real
`PlanRow`** was bundled (esbuild) with the **real `messages/en.json`** through a
`NextIntlClientProvider`, styled with the **real `app/globals.css` + `@motir/design-system` theme**,
and screenshotted headlessly in both themes before this panel was written. Four things that render
settled, which reading the `.tsx` would not have:

1. The meta line has **room**: `14 items   planned 2 hours ago` occupies under a third of it. Both
   parties fit without new chrome, a second row, or a pill.
2. The right-hand cluster is where the eye lands for STATUS. Putting attribution there would give
   the row **two chips that read as one** — a `Planned` pill beside a `Claude Code` pill is a status
   the reader will try to interpret.
3. The meta entries are visually identical to each other. A bare `Mara · via Claude Code` in that
   line reads as more timestamps — hence the **avatar** and the **glyph** (§4).
4. The shipped row does **not** render the decider, though panel A's mock draws _"approved yesterday
   by Mara"_. That drove a design rule rather than a shrug — see §3's _A DECIDED row shows the
   DECIDER_ — and the gap itself is pre-existing and **not** closed here.

## 3. What it draws — seven rows, and the FIELD each reads

The attribution is **one more entry in the row's existing meta line**, after the timestamp:
`<avatar> Mara · 🤖 via Claude Code`.

**Rows 1–4 ARE panel A's rows** — the same four plans, in the same order, with the same item counts,
op summaries, timestamps, staleness flag and accent border. This panel AMENDS A, so it must be
diffable against it: read the two side by side and the only difference is the new entry.
Substituting different plans would have forced the reader to re-read both panels to work out what
changed, which is the one thing an amendment panel exists to prevent. **Rows 5–7 are ADDED**, for
three states panel A has no row for.

| #   | row                             | the attribution shows                       | read from                                                         |
| --- | ------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **generating** (A's row 1)      | `M` `Mara`                                  | `createdById` → name; no author yet                               |
| 2   | **planned + stale** (A's row 2) | `M` `Mara` · 🤖 `via ` **`Claude Code`**    | `createdById` → name · `authorSource === 'mcp'` → `authorHarness` |
| 3   | **approved** (A's row 3)        | ✨ `via ` **`Motir AI`** — NO requester     | `sourceJobId !== null`; decided, see below                        |
| 4   | **declined** (A's row 4)        | **nothing — the entry is absent**           | neither party known (a plan older than both columns)              |
| 5   | **NOBODY asked** (cadence)      | ↻ `auto-planned` · ✨ `via ` **`Motir AI`** | `createdById === null` **and** `origin === 'cadence'`             |
| 6   | **requester, no agent**         | `P` `Priya`                                 | `createdById` set, no author and no job                           |
| 7   | **long values**                 | both names ellipsize; nothing else moves    | §5                                                                |

### A DECIDED row shows the DECIDER, not the requester

Panel A's rows 3 and 4 already end **`approved yesterday by Mara`** / **`declined 3 days ago by
Mara`** — the THIRD party, drawn since 843. A decided row that also gained a requester would
therefore carry **two bare person names in one line**, and a reader cannot tell which one holds which
role; it is the two-chips-read-as-one hazard applied to people.

The rule that resolves it is also the one that matches how the list is read: **while a plan is
UNDECIDED, _who asked_ is what you weigh — you are about to approve their request. Once it is
decided, _who decided_ is the operative fact and the requester is history.** So the row drops the
requester on `approved` / `declined`, keeps the agent (which still answers _what wrote the tree I
accepted?_), and the **detail header keeps both** (§6). It also caps the meta line at three entries
in every state.

⚠️ **`by Mara` is drawn in panel A and is NOT shipped.** `PlanRow` renders
`t(view.whenKey, { when })` — _"approved yesterday"_, with no name. That gap is pre-existing, is
**not** closed by this amendment, and is named here so nobody reads panel A as shipped behaviour or
reads this panel as having deleted something.

### ⚠️ State 3 is the one the DATA had to be shaped for, and it is not cosmetic

`createPlan` **always has an acting user**, so the requester could not simply be defaulted from the
context. On the auto-plan path that acting user is the **project owner**, substituted by
`autoPlanCadenceService` (`{ userId: owner.userId }`) purely so the job has a credential — **nobody
clicked anything**. Recording them would attribute to a real person a request they never made, on
the single plan whose whole point is that no person asked.

So `Plan.createdById` is **written ⟺ a person actually asked** (`origin === 'user'`), and state 3 is
drawn from its ABSENCE plus `origin`. The column is explicit at every call site for exactly this
reason, and the abstention is pinned by a test (`autoPlanCadence.test.ts`) rather than left to the
next producer's judgement.

### ⚠️ State 2 reads `sourceJobId !== null`, NOT `authorSource === 'native'`

[The contract decision](motir:cmsympvcb017mi4philjyjccs) deliberately does not retrofit Motir's own
generator, so **every plan the product generates carries `authorSource === null`**. Drawing state 2
off `'native'` would specify a row the surface can never render. **MOTIR-2996** retires that
inference, and when it lands this row becomes `authorSource === 'native'` with no other change.

### State 4 renders NOTHING

No em-dash, no `Unknown`, no greyed placeholder. Every plan predating these columns is in this state,
and a placeholder in a scanned list is a value the reader must learn to ignore.

## 4. Per element — the primitive, the tokens, the copy

| element                  | primitive / markup                                                                                                  | colour token                                              | shape / size                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| the attribution entry    | a `<span>` **inside the existing meta line** — no new container, no `Pill`                                          | `--el-text-secondary` (the meta line's own ink)           | inherits: `text-xs`, `gap-x-3`                                  |
| the requester avatar     | the **shipped `Avatar`** (`app/(authed)/items/_components/issueCellPrimitives.tsx`) — initial letter, `aria-hidden` | `bg-(--el-text)` / `text-(--el-text-inverted)`, unchanged | **18px** here vs its 22px row size — the meta line is `text-xs` |
| the requester name       | `<b>`                                                                                                               | `--el-text-secondary` at `font-semibold`                  | `max-w-[10rem]`, truncate                                       |
| the agent glyph          | lucide **`Bot`** (agent) · **`Sparkles`** (Motir) · **`RotateCw`** (auto-planned), `aria-hidden`                    | `--el-text-faint`                                         | `h-3 w-3`, `shrink-0`                                           |
| the harness / `Motir AI` | `<b>`                                                                                                               | `--el-text-secondary` at `font-semibold`                  | `max-w-[12rem]`, truncate                                       |
| the `·` separators       | `<span>`                                                                                                            | `--el-text-faint`                                         | —                                                               |
| the model (DETAIL only)  | `<span>` after a `·`                                                                                                | `--el-text-muted`                                         | —                                                               |

- **No new colour and no Tier-0 value.** Every ink is an `--el-*` token this surface already uses;
  the entry has no background, border or fill, so it introduces no tint.
- **The avatar is the SHIPPED primitive, resized, not a new one.** A design that hand-rolled a
  circle would drift from every other person on the product the first time that primitive changes.
- **`--el-text-faint` on the glyphs and separators is legal precisely because they are decorative.**
  `CLAUDE.md`'s measured table puts faint at 2.39–2.61 against every surface here — below AA — and
  permits it only where meaning is carried elsewhere. It is: the avatar is `aria-hidden` and the
  NAMES say the whole thing. **Neither party is ever conveyed by icon or colour alone.**

  > **⚠️ AMENDED 2026-09-03 (MOTIR-4348) — TRUE as a design intention, UNIMPLEMENTED in the
  > markup.** The avatar and the glyphs do carry `aria-hidden`, and the ink guard exempts them.
  > The **separator does not** — `.attrib .sep` is a bare `<span>` — so once the ink was declared
  > under its real name the guard ruled on it and reported it, correctly, as active informational
  > text painted below AA. It now takes `--el-text-secondary`. The alternative disposition, which
  > this sweep deliberately did not take, was to mark the separator `aria-hidden` and keep the
  > faint ink: that is an accessibility-semantics change, and it belongs to whoever owns this
  > surface rather than to a declaration-layer sweep.
  >
  > **The table row above is amended with it:** the `·` separators now read `--el-text-secondary`.
  > The agent glyph's row is unchanged — that element IS `aria-hidden`, and the guard passes it.

- **`--el-text-secondary` for the words** (6.24 on `--el-surface`, AA in both themes) rather than
  `--el-text-muted`, which clears AA only on the white page — and this row sits on `--el-surface`.
- **Copy** (i18n namespace `aiPlanning`, both catalogs — the parity gate):
  - row: `requestedBy` → `{name}` · `viaHarness` → `via {harness}` · `viaMotir` → `via Motir AI` ·
    `autoPlanned` → `auto-planned`
  - detail: `requestedByLong` → `Requested by {name}` · `writtenByHarness` → `written by {harness}` ·
    `writtenByMotir` → `written by Motir AI` · `autoPlannedLong` → `Auto-planned — nobody requested this`

## 5. Long values — what truncates, and in what order

Both names are free text of unbounded length (`authorHarness` is caller-supplied; a person's name is
whatever they set). Panel A2's sixth row draws a long person AND a long harness AND a long title in a
narrow row at once:

- **The plan TITLE keeps its own single-line ellipsis** and is **never shortened by the attribution**
  — the meta line is a separate line below it.
- **The PERSON truncates at `max-w-[10rem]`, the HARNESS at `max-w-[12rem]`**, each with its full
  value on its `title` attribute. The person is given the tighter bound deliberately: a display name
  is usually short, and when it is not, the reader still gets the leading name.
- **The avatar, the `via`, the separators, the item count and the timestamp always stay legible** —
  none of them is inside a truncating box.
- **The meta line stays `flex-wrap`**, so a row too narrow for all three entries moves the whole
  attribution to its own line, as the panel draws. It never pushes anything out of the row and never
  breaks the text column's `min-w-0 flex-1`.

## 6. The DETAIL header — the same two parties, with the roles spelled out

The plan-detail header is `PlanReviewRail`'s `<header>` (status tag + title + summary + `N items`).
The attribution joins the **`N items` line**, with **two differences** from the row:

1. **The roles are named in words** — `Requested by Mara · written by Claude Code` — where the row
   says `Mara · via Claude Code`. The row is SCANNED, and an avatar in front of a name already reads
   as _this person's_; the header is READ, once, by the person about to press Approve, and there the
   words are what stop two names being taken for one party.
2. **The header carries the MODEL**, after a `·`. It is the difference between two agent-written
   plans and nobody scans a list on it. **Absent model ⇒ the separator and the model both
   disappear**; absent everything ⇒ the entry is absent, as in the row.

The cadence state is spelled out most explicitly of all here — **"Auto-planned — nobody requested
this"** — because this is the surface where somebody is about to accept the work, and _no requester_
is a fact they should read rather than infer from a missing name.

**And unlike the row, the header keeps the requester on a DECIDED plan.** The row drops it because a
second bare name competes with the decider in a scanned line (§3); the header has neither problem —
it names the roles in words, and the decider already lives in its own **history timeline** below
(`created → planned → approved by …`), not in the same line. So an approved plan's header reads
_"Requested by Jonas · written by Motir AI"_, with the decider a row further down where it always
was.

## 7. What this amendment ASSIGNS to its sibling cards

Written into those cards in the same pass (the sweep-the-referrers rule):

- **[The Plan's authorship carrier](motir:cmsyms0us018si4phpqjya7i1)** additionally carries
  **`Plan.createdById`** (+ its `PlanCreatedBy` relation, `ON DELETE SET NULL` like `decidedById`),
  written on the request paths and deliberately NOT on the cadence path.
- **[The Plans surface shows who authored a plan](motir:cmsymy41w01fri4phh1ur2b2v)** builds every
  state above, in BOTH reads, and owes **two name resolutions the DTOs do not carry today**:
  - `PlanDto.createdById` is an **id**; the LIST row needs a **name**. `planRowView.ts` is the
    server-side place for it — it already enriches each row — and the batch must be **one query for
    the page**, not one per row.
  - `PlanReviewDto` carries neither `createdById` nor `sourceJobId`. It already resolves
    `decidedByName` through `userRepository.findById` in `planReviewService`, which is the pattern to
    follow; **without `sourceJobId` the header cannot tell state 2 from state 4** however complete
    the authorship fields are.
- **[MOTIR-2996](motir:cmsyo0t8100dpi3ph16o9k6bm)** retires the `sourceJobId` inference once the
  generator records its own attribution, at which point state 2 reads `authorSource === 'native'`.

**Explicitly NOT closed here:** the shipped row does not render the DECIDER, though panel A draws it.
That is a pre-existing gap in the third axis, out of this story's scope, and it is named so nobody
reads panel A as shipped behaviour.

---

# Part IV — The review rail's STATUS TAG is an overline, above the title (MOTIR-3074)

Amends the **header gallery** in Part I's asset — the one place that asset draws
`PlanReviewRail`'s `<header>` as it actually ships. (Panel B's rail sketch predates that header and
draws neither the plan title nor the status tag, so there is nothing in it to correct.) Placement
only: no new element, no new token, no copy change, and the `data-testid="plan-status-pill"` hook
every shipped test reads is untouched.

## 1. What changed

The tag used to share one `flex items-center justify-between` row with the title. **It now sits on
its own line ABOVE it**, and the title owns the full rail width.

## 2. Why the row failed — and why it is not an edge case

Plan titles are **generated** — long by
default, and routinely carrying a token with no break opportunity in it (a `SCREAMING_CASE`
constant, a repo name, a cuid). The rail is a fixed **22rem** column, so a `shrink-0` tag took
roughly a third of the text width; the title wrapped to five lines while `items-center` held the
one-line tag against the middle of the block, and the tag ended up **inside the title's text
column**, reading as an annotation on line 3 of the sentence rather than as the plan's state. That
is the one thing this element exists to answer — _did my plan go through?_ — and it is read at the
moment somebody is about to press Approve.

## 3. Measured, at the shipped 352px rail width

**Measured in chromium**, on the reported title (_"…into
`SHARED_PLANNING_RULES` (motir-ai) — supersedes plan `cmszanri500bfi3phws7wdiu8`"_):

| shape                                  | rail overflow | title lines | tag inside the title's rows |
| -------------------------------------- | ------------- | ----------- | --------------------------- |
| shipped — tag beside the title         | **7px**       | 5           | **yes**                     |
| guard only, tag still beside the title | 0px           | **7**       | **yes**                     |
| **tag as an overline + the guard**     | **0px**       | **5**       | **no**                      |

The middle row is why the guard alone was not the fix: it stops the overflow and leaves both the
collision and two extra lines of wrapping.

## 4. What is unchanged, and the guard on the title

**The tag keeps its full status coverage and its `data-testid` hook** — the move is placement only,
no change to the tint map, the copy, or what a test reads. It stays `align-self: flex-start` so a
flex COLUMN child does not stretch across the rail.

**And the title carries the overflow guard whatever the placement**: `min-w-0` +
**`overflow-wrap: anywhere`** (Tailwind `wrap-anywhere`). `anywhere`, not `break-word`, is
load-bearing — only `anywhere` feeds its break opportunities into the **min-content** size a
flex/grid item's automatic minimum is measured from, which is the size that pushed the `<aside>`
past its track. Measured on the same harness: `break-words` alone left the 7px overflow standing;
`wrap-anywhere` alone cleared it. With the overline placement a token wider than the _whole_
column still overflows without the guard — 324px on a 60-character token, 0px with it — so the two
halves are independent and both are owed.

This is the repo's most-repeated overflow class (`min-w-0` on a shrinkable track) landing in a
header that never got the guard; the page's own `<h1>` one level up already had it.

---

# Part V — The plan-review DETAIL surfaces: a proposal on its parent's LEVEL, and a proposal READ view (MOTIR-3082 / bug MOTIR-3070)

**Amends Parts I–IV's asset in place**: the same three files
(`design-notes.md` · `plans-surface.mock.html` · `plans-surface.png`), two new panels — **E** and **F**.
Nothing already drawn is redrawn.

| Surface                                                     | Panel | Gates      |
| ----------------------------------------------------------- | ----- | ---------- |
| The out-of-plan **parent** signal on the plan-detail canvas | **E** | MOTIR-3083 |
| The proposal **read view** and its door                     | **F** | MOTIR-3084 |

## 0. The gap, and why it needed a design pass at all

`MOTIR-3070` reports two absences on the plan-detail canvas Part I §3 Panel B draws. Panel B
specifies exactly three op treatments (`add` / `modify` / `remove`) plus MOTIR-1370's inline-edit
modal, and it specifies **no parent context on a node** and **no per-proposal detail surface**. A
`grep` across every `design/*/design-notes.md` finds neither drawn anywhere else in the tree, so both
are whole elements rather than unspecified details — the design gate's NONE-exists case, and the
reason the card's `motir run` stopped instead of improvising.

## 1. What this composes — and does NOT redesign

Per `notes.html` **#82** and **#95**: cite the asset, the COMPONENT, and its contract.

| Composed                                   | Real asset / component                                                                                                                            | What it owns — NOT re-drawn here                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The plan-detail canvas + its op treatments | Part I §3 Panel B · `components/planning/PlanItemNode.tsx` · `PlanReviewCanvas.tsx`                                                               | The three op languages, the stale badge, the drill chevron, the edit pencil, the node's fixed `NODE_W`/`NODE_H` footprint                          |
| The canvas **detail-surface pattern**      | `design/roadmap/design-notes.md` § _Canvas detail surfaces_ (MOTIR-1351) · built by MOTIR-1352                                                    | **Select a node → the selected card's `View` button → a `Modal size="xl"` peek.** This design adds no second interaction model; it reuses that one |
| The peek **body**                          | `design/work-items/quick-view.mock.html` · `components/planning/WorkItemQuickView.tsx` → `app/(authed)/items/_components/IssueQuickViewPanel.tsx` | The `.qv-head` / `.qv-body` / `.qv-main` + `.qv-rail` two-column shell, the section labels, the read-only rail rows                                |
| The dependency **ghost anchor**            | `design/roadmap/design-notes.md`, cross-level dependency                                                                                          | The red dashed + hatched off-level anchor and its `blocked elsewhere` flag — **cited here only to stay away from it** (§2)                         |
| The edit path                              | `ProposalEditModal.tsx` (MOTIR-1370)                                                                                                              | Editing an `add`. Unchanged, and still the ONLY writer                                                                                             |

## 2. Panel E — a proposed card is a NORMAL card on the roadmap level

### The problem in one sentence

`isRoot` (`lib/planning/projectCanvasModel.ts:141`) is true both for _a node with no parent_ and for
_a node whose parent is not in the rendered set_, so a proposal parented under a **committed** work
item draws at the top level, identical to a genuine root — and where a card lands in the tree is one
of the things approval decides.

### The decision: render the LEVEL, don't signal the parent (Yue, 2026-08-19)

**An earlier revision of this panel got this wrong and is recorded here rather than quietly
replaced.** It added a new element — a neutral "parent chip" pinned above the node — to _name_ the
parent the reader could not see. That answers the question by inventing vocabulary: a reader has one
more thing to learn, the canvas has one more language to keep from colliding, and the proposal still
sits alone on an otherwise empty canvas with no idea what it will live beside.

The right answer needs nothing new. **The plan-detail canvas is the roadmap, drilled to the level the
proposal lands in** — and `design/roadmap/design-notes.md` § _MULTI-LEVEL CHAINS — DRILL-DOWN_ already
specifies that surface completely:

> _"Click a node and the canvas REFRESHES to that node's children, laid out as their own chain; a
> breadcrumb (`Plan ▸ Invoices ▸ Create invoice`) + a **Back** control walks you up."_ … _"the
> consumer re-feeds the engine the children of the focused node + their same-level `blocked_by`
> edges, and tracks the breadcrumb path; **the engine is unchanged**."_

So the plan detail shows:

1. **The breadcrumb** — the committed ancestor path down to the focused level, exactly as the roadmap
   draws it. **This is what names the parent.** Not a badge, not a chip.
2. **The parent's real children** — every one of them, as ordinary committed nodes with their real
   identifiers and status pills. **They are on the canvas because they are the parent's children, NOT
   because anything depends on them**; a sibling with no `blocked_by` relationship to the proposal is
   still a sibling, and seeing the company a proposed card will keep is most of what "is this the
   right place for it?" means.
3. **The proposal**, at that same level, in the `add` style Panel B already specifies.
4. **Same-level `blocked_by` edges**, in the shipped edge language, unchanged.

**Nothing differs from the roadmap except the proposed card's style.**

### Why this dissolves the defect instead of flagging it

_Root or parented?_ stops being a question the reader has to ask. A proposal under a committed parent
is drawn **inside that parent's level**, among its siblings, with the parent in the breadcrumb; a
genuine root is drawn at the **top** level, where there is no breadcrumb to walk. The two read
differently because they **are** in different places — which is a distinction the reader already
understands from the roadmap, rather than one this surface teaches them.

It is also why no new visual language is introduced, and therefore why none of the canvas's reserved
languages (the three op treatments, the red hatched dependency tangle, the dashed _not in sprint_)
had to be worked around. The earlier revision spent a section arguing its way past them. The right
design never approaches them.

### States

- **A proposal under a committed parent** — drawn at that parent's level, breadcrumb walking to it.
- **A genuine root proposal** — the top level, no breadcrumb.
- **An archived or hard-deleted parent** — the level cannot be opened, so the proposal falls back to
  the top level and the breadcrumb has nothing to walk. That is the honest rendering, and it is the
  same one a genuine root gets (MOTIR-3083 AC 5's _degrade rather than throw_).
- **A plan whose proposals sit under SEVERAL committed parents** — they are at different levels, so
  the canvas cannot show them at once; that is the drill-down model working, not a gap. The review
  rail remains the whole-plan list, and selecting an item there drills the canvas to its level.

### What this does NOT change

`isRoot` keeps its contract — it is correct for its stated purpose. What changes is what the plan
canvas is FED: the committed level plus the plan's proposals, rather than a forest built from
`PlanItem`s alone (`buildPlanForest`). The canvas engine is untouched, per the roadmap's own build
note.

## 3. Panel F — read a proposal with the SHIPPED quick view, and REMOVE the edit modal

### The decision (Yue, 2026-08-19)

**Viewing a proposal is viewing a card.** It uses the same `Modal size="xl"` + `IssueQuickViewPanel`
quick view a normal work item gets, with **editing disabled** — not a bespoke panel that resembles it.

**And the proposal EDIT modal is REMOVED.** MOTIR-1370's inline-edit form over five fields is
withdrawn: manual editing of a proposal is not needed. A proposal is **read**, and changed by
**re-planning** — which is the model the rest of the product already runs on, where a plan is a
proposal a person accepts or declines rather than a draft they hand-correct. Part I §3 Panel B's
inline-edit bullet and panel **B′** are **SUPERSEDED**; they stay in the asset marked as such,
because they are the record of what shipped, not a live specification.

This also settles the door cleanly. The node's control cluster carries **`View` and nothing else**.

### The door

MOTIR-1351 specifies **select a node → the selected card's `View` button → a `Modal size="xl"` peek**,
and MOTIR-1352 shipped it for work-item nodes. The proposed node gains the same `View`, on **every**
op. A `modify` / `remove` peeks its **live target** — the already-shipped `WorkItemQuickView`,
unchanged. An `add` peeks its proposal.

### The body for an `add` — and the one difference forced by the model

The shipped work-item peek ends with a deliberate deferral:

> _"Explanation, child items, the full relationships / links panel, attachments, and the activity
> feed live on the **full page**."_

That is correct for a work item and **impossible for a proposal**: there is no per-item route
(`app/(authed)/plans/` holds `page.tsx` and `[id]/page.tsx`), and MOTIR-3070's sharpest finding is
that `explanationMd` is carried, diffed and materialized while nothing in the review surface reads it.
**So the proposal peek renders both bodies inline.** That is not a departure from _"the same as
viewing a normal card"_ — it is what the same experience means when the page the peek defers to does
not exist.

| Field                             | Rendered as                                                     | Composed from                                             |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `descriptionMd`                   | `Description` section, **Markdown**                             | `.qv-section-label` + `.qv-desc` (the shipped peek)       |
| `explanationMd`                   | `Why this matters` section, **Markdown**, directly below        | the same pair — the item page renders the two as siblings |
| `kind` · `type`                   | rail rows with the shipped `IssueTypeIcon` + work-type chip     | `.qv-rail` `.rail-field`                                  |
| `priority`                        | rail row, shipped priority chip                                 | `.rail-field`                                             |
| `storyPoints` · `estimateMinutes` | one rail row each                                               | `.rail-field`                                             |
| `targetRepo` / `targetRepoRole`   | rail row, mono repo name; the ROLE when no name is pinned yet   | `.rail-field` + `design/work-items/repository-set.*`      |
| `executor`                        | rail row — _Coding agent_ / _Human_                             | `.rail-field`                                             |
| `explanationSource`               | a quiet `AI-drafted` marker beside the `Why this matters` label | the shipped provenance chip language                      |

**The head differs from the work-item peek only where the model has nothing to put there:** no
identifier (a proposal has none until it materializes — the `new` the node already shows), no status
pill (same reason), and no `Open full page →` (there is no page). The rail is read-only, as the
shipped peek's already is.

### After a decision

A **decided** plan is read-only per Part I, and the read view **stays available** on it — reading is
what a decided plan still supports, and it is how somebody later answers _what did we approve?_.

### a11y

`Modal` owns focus trap, `Esc` and the backdrop; the dialog is labelled by the proposal title. The op
badge carries **text**, not colour alone. `View` is an icon button with an `aria-label` that stops
propagation so a press cannot start a canvas drag — the same guard the shipped node's controls use.
Copy lives in the `planReview` namespace.

## 4. Tokens + primitives

Colour via the element/semantic tokens only, inlined here as light values exactly as
`quick-view.mock.html` does; no Tier-0 `--color-*`, no raw `rounded-md` / `p-2` / `h-9`.

> **⚠️ AMENDED 2026-09-03 (MOTIR-4348).** "Inlined here as light values" was true; "via the
> element/semantic tokens" was not. Panels E and F live in `plans-surface.mock.html`, whose `:root`
> declared the values under PRIVATE names rather than `--el-*` ones, so every ink on these two
> panels was outside both ink guards. The asset now declares the real token names and consumes them
> at every paint site; see Part I §4's amendment for the full account.
> Everything
> composes a shipped primitive — `Modal`, `Card`, `Pill`, `SectionLabel`, `IssueQuickViewPanel`,
> `CoreFieldsPanel`, `IssueTypeIcon`. **No new primitive is introduced**; a genuinely new one would be
> its own design subtask.

## 5. GIVES / TAKES sweep

`grep`ped this asset for every `MOTIR-<n>` it names, and read the result against MOTIR-3070's subtree
(the asset's key list says where to START; the subtree says where to STOP):

| Key                                             | Gives / takes                                                                              | Action                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| **MOTIR-3083**                                  | **GIVES** panel E — the parent chip, its states, and the rule that `isRoot` is not touched | none; its ACs already say this        |
| **MOTIR-3084**                                  | **GIVES** panel F — the door, the head's three differences, the field-by-field body        | none; its ACs already say this        |
| MOTIR-3070                                      | **GIVES** its two UI criteria a drawn answer                                               | none — the parent record is unchanged |
| MOTIR-1370                                      | neither — the edit modal is untouched and stays the only writer                            | none                                  |
| MOTIR-1351 / MOTIR-1352                         | neither — this composes the shipped detail-surface pattern and adds no second one          | none                                  |
| MOTIR-847 / MOTIR-850 / MOTIR-2982 / MOTIR-2985 | neither — cited as history / provenance                                                    | none                                  |

**One card is TAKEN from — MOTIR-3083, a STRUCTURE rather than an element** — and it was amended in
the same pass, per the design limb's rule that the design and the AC amendment ship together. Nothing
else in the subtree is invalidated: MOTIR-3084's read view is untouched by the Panel E redesign, and
MOTIR-3070's criterion 2 still holds (_distinguish, and name the parent_) — the level model satisfies
it by placement and breadcrumb rather than by a badge.

---

# Part VI — The DECIDED plan-review surface: the accepted / declined node treatments, and what the canvas pane holds after approve (MOTIR-3159 / bug MOTIR-3154)

**Amends Parts I–V's asset in place**: the same three files
(`design-notes.md` · `plans-surface.mock.html` · `plans-surface.png`), two new panels — **G** and **H**.
Nothing already drawn is redrawn. The three shipped `op` frames, Panel E's level model, Panel F's read
view, Part IV's status overline and Part III's attribution rows are all untouched and composed as they
stand.

> **⚠️ AMENDED 2026-09-10 (MOTIR-5050) — Panel H gains a THIRD frame, `H·v6`: the population that
> draws NO band.** §4's amendment carries the decision and the predicate;
> `design/repository-set/design-notes.md` §7b is the design of record for the step itself. Both
> ai-planning assets that draw the band were re-exported in the same pass, and the two frames whose
> band still showed the retired `I already have code` secondary were refreshed to the shipped v5 step
> (one action, no branch — MOTIR-5014).
>
> **Re-export, with the exporter's baseline verdict per asset** —
> `node scripts/render-design-mock.mjs <mock>`, viewport **1200 × 900** at `deviceScaleFactor: 2`:
>
> | asset                       | baseline verdict | committed → new         |
> | --------------------------- | ---------------- | ----------------------- |
> | `plans-surface.png`         | **EXACT**        | 2400×14950 → 2400×16326 |
> | `plan-detail-list-view.png` | **EXACT**        | 2400×7360 → 2400×7784   |
>
> `EXACT` means the exporter's render of each asset **at `HEAD`** was byte-identical to the committed
> PNG, so the whole difference between the old export and the new one is this revision's diff and none
> of it is environment drift. Neither surface ships a `<name>.dark.png`, so one board each is the
> complete set.

| Surface                                         | Panel | Gates                  |
| ----------------------------------------------- | ----- | ---------------------- |
| The **accepted** / **declined** node treatments | **G** | MOTIR-3161             |
| What the canvas pane holds **after approve**    | **H** | MOTIR-3161, MOTIR-3162 |

## 0. The gap — a lifecycle drawn state by state, with no owner for the last state

Part I drew the generating state and the pending state. Part IV drew the status tag. Part V drew the
level model and the read view, and closed with one sentence about the state after a decision — _"a
decided plan is read-only per Part I, and the read view stays available on it"_ — which is true and is
not a specification of what the surface SHOWS.

So the decided state is the one nobody drew, and three separate cards each filled it locally, each
sensibly inside its own file:

- `declinePlan` **deletes** every `plan_item` row (`lib/services/plansService.ts:2068` →
  `planItemRepository.deleteByPlan`), so a declined plan's review model is `items: []` for ever.
- `PlanDetail` hands the **whole canvas pane** to `RepositorySetStep` whenever a repository set exists
  (`components/planning/PlanDetail.tsx:196-217`), and `approvePlan` proposes that set before
  materializing — so an ordinary approve creates the rows that then take the pane.
- `PlanItemNode` frames a card by **`op` alone** (`:74-80`), so there is no accepted or declined
  treatment to give it.

None of the three is wrong about its own file. Together they make the surface unable to show a
decision it has just taken. That is the shape MOTIR-3155 records, and drawing the whole lifecycle once
is what stops a fourth card from doing it again.

## 1. Drawn against SHIPPED reality — what was RENDERED first

Per the design-against-shipped-reality rule, and Part II §1's format. The real `PlanDetail` island was
bundled and rendered headless off `origin/main` `c57daef8` — the actual component, the actual
`packages/design-system/theme.css`, the actual `messages/en.json` — at 1440×820, `deviceScaleFactor: 2`,
light theme, in the three states below. The harness was deleted before the design lane was run; the
screenshots are attached to the pull request.

| State                                                     | What the render SHOWS (not what the source suggests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `planned` (the baseline)                                  | Four proposal nodes on the level in their three op frames; rail reads **Ready to review · 4 proposed items**, Approve / Decline beneath.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `approved` (+ a one-row repository set **Motir creates**) | The canvas pane is **entirely** the establish step — _"YOUR PROJECT'S CODE / Motir will host your code"_, the it's-yours callout, **Continue** + _I already have code_. Rail reads **Approved · 4 proposed items · Added 4 items to your backlog**. The four cards are nowhere on the page. **⚠️ AMENDED 2026-09-10 (MOTIR-5050) — the parenthesis used to read "(+ a one-row repository set)" and the set it was rendered with was one Motir CREATES. That is one of two populations; see §4's v6 amendment for the other, which this render does not describe.** |
| `declined`                                                | The pane holds the roadmap's own empty state — **"Nothing on the roadmap yet / Work items will appear here as the plan takes shape."** Rail reads **Declined · 0 proposed items**, with the correct outcome line _"Plan declined — your tree was left untouched"_ beneath it.                                                                                                                                                                                                                                                                                      |

Two things only a render settles, and both shaped the panels below:

1. **The declined pane is not blank — it is confidently WRONG.** It reads _"work items will appear
   here as the plan takes shape,"_ which is the roadmap's empty copy addressed to a plan that has
   already finished. The rail says the right thing four inches away. So Panel G is not "fill an empty
   space"; it is "stop a correct component from being handed nothing to say".
2. **The rail is already RIGHT in both decided states.** `DecidedOutcome`
   (`components/planning/PlanReviewRail.tsx:323-`) renders _Added N items to your backlog_ with a
   `--el-success` `Sparkles`, and _Plan declined — your tree was left untouched_ with a neutral
   `--el-text-muted` `X`. **The outcome language this surface needs already exists on the page**, so
   Panel G borrows it rather than inventing a second one — which is why nothing below is new vocabulary.

## 2. What this composes — and does NOT redesign

| Composed                         | Real asset / component                                                                                 | What it owns — NOT re-drawn here                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| The three `op` languages         | Part I §3 Panel B · `components/planning/PlanItemNode.tsx:74-80`                                       | `add` dashed-accent, `modify` info-ring, `remove` muted-strike. **Untouched — Panel G crosses them, never joins them** |
| The canvas LEVEL model           | Part V Panel E · `components/planning/planLevel.tsx` · `PlanReviewCanvas.tsx`                          | Breadcrumb, the parent's real children, same-level `blocked_by` edges                                                  |
| The proposal READ view           | Part V Panel F · `ProposalQuickView.tsx`                                                               | The door, the body, its availability on a decided plan                                                                 |
| The rail's decided OUTCOME       | `components/planning/PlanReviewRail.tsx` `DecidedOutcome`                                              | _Added N items…_ / _Plan declined…_, the `--el-success` and neutral glyphs — **Panel G borrows this language**         |
| The establish STEP               | Story MOTIR-1775 · MOTIR-1782 · `components/planning/repositories/RepositorySetStep.tsx`               | Every pixel INSIDE the step. Panel H moves its container and changes nothing else                                      |
| The reserved dependency language | `design/roadmap/design-notes.md` — the red dashed + hatched cross-level anchor, dashed _not in sprint_ | Cited only to stay away from it (§3)                                                                                   |

## 3. Panel G — a DECIDED node: the outcome is a FOURTH AXIS that crosses the three ops

### Why it cannot be a fourth op

`op` and `outcome` are independent: every one of the three ops can be accepted and every one can be
declined, so there are **six** renderings, not four. A fourth member of the `op` set could only express
three of them. The outcome therefore has to ride on channels the op languages do not use at all — and
the op languages already consume border **style** (dashed vs solid), border **colour**, **fill**, the
**ring**, **opacity** and the **strike-through**.

### The two channels, and why they are free

**1. The op badge gains a second SEGMENT — the outcome word.** The shipped `OpBadge` sits at the top-left
of the node and carries the op in text already. A decided node fuses a second segment to its trailing
edge, so the chip literally reads _op × outcome_:

| chip                                      | segment 1 (the shipped op tone, unchanged)       | segment 2 (the outcome)                           |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `add · accepted`                          | `bg-(--el-accent)` / `text-(--el-accent-text)`   | `bg-(--el-tint-mint)` / `text-(--el-text-strong)` |
| `add · declined`                          | as above                                         | `bg-(--el-muted)` / `text-(--el-text-secondary)`  |
| `change · accepted` / `change · declined` | `bg-(--el-tint-sky)` / `text-(--el-text-strong)` | as the two rows above                             |
| `remove · accepted` / `remove · declined` | `bg-(--el-muted)` / `text-(--el-text-secondary)` | as the two rows above                             |

Shape: the fused chip keeps `--radius-badge` on its outer corners and `--spacing-chip-x/y` per segment;
the seam is a 1px `--el-border-soft` rule, not a gap.

**2. A solid 3px SPINE on the node's inline-start edge**, full height, inside the node's own border:
`--el-success` for accepted, `--el-text-muted` for declined. This channel is **verifiably unclaimed** —
`grep` for `border-l` / `border-s-` / a `w-[3px]` bar across `PlanItemNode.tsx`, `WorkItemNode.tsx` and
`ProjectRoadmapCanvas.tsx` returns nothing, and every reserved language in `design/roadmap/design-notes.md`
is either a border **style** (dashed _pending_, dotted _skippable_, dashed _upcoming_) or a red **chip**
(_blocked elsewhere_, _not in sprint_). A solid bar on the leading edge is neither.

Its two values are not chosen: they are the rail's own outcome colours one component down —
`--el-success` is the `Sparkles` on _Added N items to your backlog_, and the neutral is the `X` on _Plan
declined_. The node and the rail therefore say the same thing in the same colour, four inches apart.

### Non-collision, stated explicitly

- **Against the three op frames** — the spine is a solid fill inside the border; no op treatment paints
  the leading edge, and the chip's op segment is byte-identical to the shipped `OpBadge`. Adding the
  axis changes no existing pixel of any op.
- **Against the red dashed + hatched cross-level dependency anchor** — the spine is solid, neutral or
  green, on the node itself rather than an off-level stub, and carries no hatch.
- **Against dashed _not in sprint_ / dotted _skippable_ / dashed _upcoming_** — the axis touches no
  border style at all.

### State is carried by TEXT, not colour

The outcome word is IN the chip (`accepted` / `declined`), which is the whole of the meaning; the spine
is decorative reinforcement (`aria-hidden`) that makes the outcome legible at a zoom where 10.5px chip
text is not. Nothing is conveyed by colour alone, which is the a11y rule Part I §4 already holds this
asset to. And because the meaning is redundant in text, WCAG 1.4.11 does not bind on the spine — but
the values clear it anyway against every surface it can sit on.

### One signal that is FREE, and one that must not be faked

MOTIR-3160 keys a materialized `add` by its `plan_item.workItemId` and populates `identifier`. So an
**accepted `add` shows its real key** — `MOTIR-3166` — exactly where a pending one shows `new`, and it
lands ON the committed node rather than beside it as a keyless ghost. That is the strongest accepted
signal on the card and it costs no pixels.

A **declined `add` keeps `new`**, and must: it never became anything, and inventing a key for it would
be the surface asserting a work item that does not exist.

### States

- **Accepted `add`** — the op frame it had, the green spine, `add · accepted`, its real identifier and
  the target's live status pill (it is a work item now).
- **Declined `add`** — the op frame it had, the neutral spine, `add · declined`, still `new`, no status
  pill (there is no work item to have one).
- **Accepted `modify`** — the committed node, info ring, green spine, `change · accepted`; the diff
  overlay stays and now reads as history — what this plan changed, old → new.
- **Declined `modify`** — the committed node unchanged, neutral spine, `change · declined`, diff shown
  as what was proposed and refused.
- **Accepted `remove`** — muted frame + strike, green spine, `remove · accepted`. The target is archived;
  the strike is now a statement of fact rather than a proposal.
- **Declined `remove`** — muted frame + strike, neutral spine, `remove · declined`. **The strike is the
  one place a reader could be misled** — it says _will be archived_ about a card that was not. The chip's
  `declined` segment is what corrects it, which is why the outcome must never be colour-only here.
- **A decided plan whose target has since been archived or hard-deleted** (`targetMissing`) — unchanged
  from today; the decided axis adds nothing to a case Part I already covers.

### The level caption

The canvas's level caption (Part V Panel E's `Proposed by this plan`) becomes the plan's outcome, once,
above the level: **`Approved · 4 items added to your backlog`** / **`Declined · nothing was created`**.
Same primitive, same placement, one word of copy per outcome — so the page states the decision at a zoom
where no chip is readable. Copy lives in the `planReview` namespace, and every new `en` key owes its `zh`
counterpart (the per-card floor on MOTIR-3161 and MOTIR-3162).

## 4. Panel H — what the canvas pane holds after approve: **BOTH, STACKED — the step takes a band, not the pane**

### The decision, and the shipped one it re-opens

Story **MOTIR-1775** / **MOTIR-1782** decided this deliberately, and the shipped prop doc on
`PlanDetailProps.repositorySet` states the intent in its own words:

> _"Present → the canvas pane holds the ESTABLISH STEP instead of the proposals: once the plan has
> materialized, the canvas of proposals has served its purpose, and replacing it is the truthful use of
> the space."_

**That sentence is correct on its own premise, and this report overturns the premise rather than the
conclusion.** The premise is that the pane holds **proposals** — and a proposal genuinely is spent by
the decision that resolves it, so replacing it with the next task WAS the truthful use of the space.

After MOTIR-3160 and MOTIR-3161 the pane no longer holds proposals. It holds **the record of the
decision**: the accepted cards, on their real level, on the work items they became. A record is not
spent by the decision — it is _produced_ by it. So _"has served its purpose"_ stops describing what is
in the pane, and with it the reason for replacing it.

There is a second, sharper reason the two can share the space at all. **They are different kinds of
thing.** The establish step is a **task** — MOTIR-1782's own central claim is that its default path is
_one sentence, one primary, one quiet secondary_. The canvas is a **record**. A task and a record can
share a pane along the vertical axis; only two records compete for it. That is why replacing was
reasonable when the pane held a spent artifact and is not once it holds a record.

**So: BOTH, stacked.** The establish step keeps the TOP of the canvas pane, at its own natural height,
for as long as it is unanswered. The canvas takes the remainder and is **never replaced**. When the step
reaches its settled state it collapses to its shipped one-line form and the canvas has effectively the
whole pane — no extra rule needed, because the step's own design already shrinks.

> **⚠️ AMENDED 2026-09-10 (MOTIR-5050) — THE LAST SENTENCE IS FALSE, AND IT IS THE CLAUSE THAT LEFT
> THIS PART WITH NO STATE FOR A SETTLED SET.** _"The step's own design already shrinks"_ is what made
> a second rule look unnecessary, and the step does not shrink: a set whose rows are all settled puts
> `RepositorySetStep` in its **`ready`** arm, which renders the overline, the `<h2>` _"Motir will host
> your code"_, the ✅ ready line, the 🔒 ownership promise and the access report — four elements at the
> step's full height, not a one-liner. For a set Motir just CREATED that is correct and is the report
> MOTIR-5015 specified. **For a set that ARRIVED settled — every row `connected`, because the
> repositories are the organisation's and onboarding connected them — there is nothing to report and
> three of those four elements are false.**
>
> **The stacking decision above is UNCHANGED and is not what this amendment touches.** Band above,
> canvas below, never replaced, for every project with code to establish. What is added is the
> population where the band is **not drawn at all**, and the predicate that decides it:
>
> ```
> drawBand  ⟺  set.rows.some(r => r.state is 'proposed' | 'creating' | 'created' | 'failed')
> ```
>
> so **a set whose every row is `connected` or `skipped` draws no band and the canvas has the whole
> pane.** `design/repository-set/design-notes.md` **§7b (Panel 9)** is the design of record for it —
> the element-by-element read of what the shipped step says for that population, why `state` is the
> discriminator and `set.ownership` cannot be, what the reader is told instead (the rail's own line,
> and nothing added), and the MIXED set's two scoped strings. Panel H's third frame in
> `plans-surface.mock.html` draws the absence.
>
> **And the shipped gate is a row COUNT, not this predicate** —
> `app/(authed)/plans/[id]/page.tsx` reads `repoView.set.rows.length > 0` — which is why a person sees
> the band today. Closing that is **MOTIR-5049**, which this card blocks.

**Nothing inside the step changes.** Panel H moves its container and touches no pixel of its content,
its copy, its primary, its secondary or its states. MOTIR-1782 keeps every decision it made about what
the step SAYS; what is re-decided is only whether saying it costs the user the thing they just approved.

MOTIR-3073 already trimmed this swap for a project that ARRIVES with code — the same sentence, stopped
half-way. This finishes it for a project that does not.

### The band

- Full width of the canvas pane, above the roadmap's search row, at the step's own natural height.
- `bg-(--el-surface)` with a `border-b border-(--el-border)` hairline; the pane's own
  `--radius-card` top corners are inherited, not re-declared.
- The canvas occupies the remainder with `min-h-0` so it can shrink rather than push the band out — the
  shrinking-list rule; the roadmap is pan/zoom and has never required the full pane.
- Below `1024px` the band and the canvas keep the same order; the step already wraps.
- **Declined** — no repository set is proposed, so there is no band at all, and the canvas has the pane.
  This panel changes nothing for a decline; Panel G is the whole of that state's fix.

### What the reader gets back

The render in §1 is the test: today an approve replaces four cards with a question. With the band, the
same approve shows _Approved · 4 items added to your backlog_ over four cards carrying their new keys,
with the repository question above them — the answer to _what did I just say yes to_ is on the surface
that asked it, which is the whole of MOTIR-3154's report.

## 5. Tokens + primitives

Colour via `--el-*` element/semantic tokens only — inlined in the mock as light values exactly as Parts
I–V do; no Tier-0 `--color-*`, no invented hue.

> **⚠️ AMENDED 2026-09-03 (MOTIR-4348) — both limbs were false, and the citation propagated the
> error.** Parts I–V inlined light values under PRIVATE names, not `--el-*` ones, and the asset
> carried six invented hues in its `:root` plus fifty raw literals at points of use. "Exactly as
> Parts I–V do" was therefore an accurate description of a practice that was itself the defect.
> `plans-surface.mock.html` now declares the real `--el-*` names; Part I §4's amendment carries the
> account, the AA findings the swap exposed, and the hue-by-hue table's home.
> Shape via the element-semantic tokens (`--radius-badge`
> for the chip, `--radius-card` for the pane, `--spacing-chip-x/y`, `--el-border-soft` for the seam); no
> raw `rounded-md` / `p-2` / `h-9`. Everything composes a shipped primitive — `PlanItemNode`, `OpBadge`,
> `Pill`, `SectionLabel`, `PlanReviewCanvas`, `RepositorySetStep`. **No new primitive is introduced**; the
> fused chip is the shipped `OpBadge` with a second segment, and the spine is a border on a box that
> already exists.

## 6. GIVES / TAKES sweep

`grep`ped this asset for every `MOTIR-<n>` it names and read the result against MOTIR-3154's subtree
(the asset's key list says where to START; the subtree says where to STOP).

| Key                                                                       | Element / structure / premise                                                                                                              | Gives / takes                   | Action                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| **MOTIR-3161**                                                            | **ELEMENT** — Panel G's fused chip, the spine, the six states, the level caption; **STRUCTURE** — Panel H's stacked pane                   | **GIVES**                       | none; its criteria already say _"in the treatment the design decides"_  |
| **MOTIR-3162**                                                            | **STRUCTURE** — the workspace canvas keeps `review` after approve AND discard, so the same decided treatment has something to draw         | **GIVES**                       | none; its criteria are about the overlay surviving, which this presumes |
| **MOTIR-3160**                                                            | **PREMISE** — an accepted `add` keyed by `workItemId` is what lets the treatment land ON the committed node                                | **GIVES** (consumes, not takes) | none — this design depends on 3160, and 3161 already `blocked_by` both  |
| **MOTIR-3163**                                                            | **ELEMENT** — the E2E now has named things to assert: the chip's outcome word and the band's coexistence                                   | **GIVES**                       | none; its criterion is _the outcome ALONGSIDE the proposals_, satisfied |
| **MOTIR-3165**                                                            | neither — a decided plan's staleness verdict is an engine rule, and this draws no stale treatment                                          | neither                         | none                                                                    |
| **MOTIR-1775 / MOTIR-1782**                                               | **PREMISE** — their _replace the pane_ decision is re-decided here, in the open, to _stack_                                                | **TAKES**                       | **applied — see below**                                                 |
| MOTIR-3073                                                                | **PREMISE** — it trimmed the same swap one case at a time; this finishes the sentence rather than contradicting it                         | neither                         | none — its own case is unchanged                                        |
| MOTIR-1377                                                                | **PREMISE** — its `decided` short-circuit exists because a declined plan had no items; once it has them the guard stops shadowing anything | neither                         | none — removing it is MOTIR-3161's call, as that card's scope says      |
| MOTIR-3082 / MOTIR-3083 / MOTIR-3084                                      | neither — Panels E and F are composed as they stand                                                                                        | neither                         | none                                                                    |
| MOTIR-843 / MOTIR-847 / MOTIR-1370 / MOTIR-3070 / MOTIR-3074 / MOTIR-2985 | neither — cited as history / provenance                                                                                                    | neither                         | none                                                                    |

**The one TAKES, and how it is discharged.** MOTIR-1775 and MOTIR-1782 are both `done` and merged; their
acceptance criteria describe a step that shipped and still ships, and **not one of them is invalidated** —
the step's content, copy, states and behaviour are exactly as they specified. What this design takes is
narrower and is a PREMISE, not an element: _the step occupies the pane INSTEAD of the canvas_. Because
that premise lives in a shipped prop doc rather than in a criterion, the amendment owed is to the
**code comment that states it**, and that edit belongs to MOTIR-3161 — the card that opens
`PlanDetail.tsx`. It is named there so the re-decision cannot land as a silent edit: the comment must be
REPLACED with the stacked rule and a citation of this Part, never deleted.

## 7. Access path

Unchanged — the "Plans" left-nav entry → the Plans list → a row → the plan detail (Part I §5). A decided
plan is reached exactly as an undecided one is; the only difference is what the pane holds when you get
there, which is the subject of Panels G and H.

---

# Part VII — The Plans list, TABBED by status (MOTIR-3233 / Story MOTIR-3232)

**Its OWN asset**: `design/ai-planning/plans-tabbed-list.mock.html` + `plans-tabbed-list.png`,
four panels, plus this section in the area's shared `design-notes.md`.

**It does NOT amend `plans-surface.mock.html`, and that asset is not re-exported** — see _A design
result is a MOMENT_ above. What Part VII takes from it, it takes by CITATION: panel A's row shape
and panel A2's attribution entry are composed as drawn, and panel A2's rows are reproduced in
panel 2 so the decided-row change is diffable by reading the two files side by side.

It draws the `/plans` LIST surface and nothing else. The plan DETAIL is
[Part VIII](motir:cmt1lb9w600cci3phl3e3aysq)'s and the canvas's own behaviour is Part IX's; neither
is drawn here.

## 0. Why tabs, and why `Planned` is the default

The statuses are not categories somebody invented for a page — **they are the plan lifecycle**, and
each asks the reader a different question. `Planned` is _decide this_. `Generating` is _wait_.
`Approved` and `Declined` are _what happened_. A single reverse-chronological stream mixes all four,
so the one plan waiting on a decision sits below however many spinners the week produced — which is
the state the request came out of. **Defaulting to `Planned` is the surface saying what it is for.**

The tab set IS the shipped four-member `PlanStatus` enum. No member is added: the three histories
`declined` now covers stay a `decisionReason`, exactly as MOTIR-3189 decided.

## 1. What is UNCHANGED — composed, not redrawn

- **The row's own shape**: the 32px status icon-square, the title line, the meta line, the
  right-hand pill cluster, the accent border on a `planned` row awaiting review.
- **The status pills** and their tones; **the staleness flag**; the rule that status is carried by
  TEXT, not colour alone.
- **The left-nav access path** (Part I §5) and the row as a single `<Link>` into `/plans/[id]`. No
  new door.
- **The plan DETAIL surface entirely** — the canvas, the review rail, the history timeline, the
  approve / decline bar, the establish band.

## 2. Drawn against SHIPPED PIXELS — what was RENDERED first, and what it settled

Part III §2 bundled the real `PlanRow` with the real `messages/en.json` through a
`NextIntlClientProvider`, styled it with the real `app/globals.css` + `@motir/design-system` theme,
and screenshotted it headlessly before a word was written. The same was done here, adding the real
`Segmented` primitive and the real page header's markup, at **375 / 700 / 1200px in both themes**.
Four things that render settled, none of which is legible in the `.tsx`:

1. **The four-tab strip is 310.3px wide with labels alone** — segments 84.3 / 67.7 / 75.7 / 70.6 —
   **and 358.8px once each carries a count.** The width is INTRINSIC: identical at all three
   viewports, because the control is `inline-flex` and never stretches.
2. **The authed shell is `px-4` below `sm`**, so a 375px viewport gives the page a **343px** content
   box. `310.3 < 343 < 358.8`. **The labels fit and the counts do not**, by 15.8px — a real
   overflow, not a near miss. §4 is that disposition.
3. **At 375px the shipped header WRAPS.** `flex-wrap` drops the Plan-with-AI pill onto its own line,
   under a subtitle that has already wrapped to two. Removing that pill (§5) removes the wrap — a
   second reason for the removal beyond the duplication it exists to fix.
4. **A `planned` row's meta line already takes SIX lines at 375px** (138px tall) with title,
   item count, timestamp and attribution — while the same row is one line at 700px and above. The
   meta line is the phone-width pressure on this surface, which is exactly why §3 puts the second
   person INSIDE an existing entry rather than adding a fourth.

**And the mock reproduces the primitive to the pixel.** The asset's `.tabs` block measures **310.3px
and 358.8px, with segment widths 84.3 / 67.7 / 75.7 / 70.6 and 96.5 / 79.8 / 87.8 / 82.7** — the
same numbers as the real `Segmented` render, at every viewport. That agreement is what makes the
measurements in §4 readable off the asset rather than only off a throwaway harness.

## 3. A DECIDED row names BOTH people — this REVERSES Part III §3

**The superseded rule, quoted in full so the reversal is legible:**

> ### A DECIDED row shows the DECIDER, not the requester
>
> Panel A's rows 3 and 4 already end **`approved yesterday by Mara`** / **`declined 3 days ago by
Mara`** — the THIRD party, drawn since 843. A decided row that also gained a requester would
> therefore carry **two bare person names in one line**, and a reader cannot tell which one holds
> which role; it is the two-chips-read-as-one hazard applied to people.
>
> The rule that resolves it is also the one that matches how the list is read: **while a plan is
> UNDECIDED, _who asked_ is what you weigh — you are about to approve their request. Once it is
> decided, _who decided_ is the operative fact and the requester is history.**

**It is reversed, and the hazard it names is real.** What was wrong is the premise underneath it:
that the two names would land in the SAME entry. They do not have to.

**The decision: the two roles live in DIFFERENT meta entries, and the entry is what says the role.**

- **The DECIDER rides the WHEN entry**, where panel A has drawn it since 843 —
  `approved yesterday by Mara` — with the verb in front of it.
- **The REQUESTER rides the ATTRIBUTION entry**, behind its avatar, exactly as it does on an
  undecided row. Nothing about that entry changes: same avatar, same `·`, same agent half.

So an approved row's meta line reads
`8 items · approved yesterday by Mara · ⟨av⟩ Jonas · via Motir AI`, and no reader has to work out
which name is which: one is preceded by _approved … by_, the other by a face. **Part III's
three-entry cap is untouched** — the requester goes INSIDE entry 3 and adds no fourth entry, which
is why finding 4 above (six meta lines at phone width) does not get worse.

### ⚠️ And the other half of this Part is that the decider was NEVER BUILT

Part III recorded the gap in its own warning paragraph and left the rule standing on top of it:

> ⚠️ **`by Mara` is drawn in panel A and is NOT shipped.** `PlanRow` renders
> `t(view.whenKey, { when })` — _"approved yesterday"_, with no name.

So today's decided row names **nobody**: the rule was protecting a collision that could not occur,
because half of it did not exist. Part VII specifies **both** halves — the decider is drawn AND
built ([the decided-row card](motir:cmt1lba1600cgi3ph9crmidd1) owns it), and the requester comes
back.

### The decider is OPTIONAL, and row 8 is why

A plan the abandoned-plan sweep terminated is `declined` with **`decidedById` NULL** and
`decisionReason: 'abandoned'` (MOTIR-3236) — nobody decided it. Panel 2's row 8 draws that state:
`3 items · declined 2 days ago · ⟨av⟩ Mara · via Claude Code`, with **no `by` at all**. This is
Part III's own _absence, never a placeholder_ rule applied one axis over: no em-dash, no `Unknown`,
no greyed name. A `decidedById` that is null renders the plain
`aiPlanning.declinedAt` string the row uses today.

**Neither party is ever conveyed by colour or glyph alone.** Every one of them is a name; the
avatar is `aria-hidden` and the agent glyph is decorative, exactly as Part III §4 set them.

## 4. The TAB STRIP, per element — and its below-`sm` disposition

| element               | primitive / markup                                                                                | colour token                                                | shape / size                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| the strip             | the shipped **`Segmented`** (`packages/design-system/src/components/ui/Segmented.tsx`), unchanged | track `--el-tabnav-track`, border `--el-border`             | `--radius-btn`, 2px inset (`p-0.5`)                                   |
| one tab               | its `<button aria-pressed>` — a real button, keyboard-operable, announced as a toggle             | inactive ink `--el-text-secondary`; hover `--el-text`       | `--height-control`, `--spacing-control-x`, `calc(--radius-btn - 2px)` |
| the SELECTED tab      | the same button, `aria-pressed="true"`                                                            | fill `--el-page-bg`, ink `--el-text-strong`                 | `--shadow-subtle`                                                     |
| the count             | the primitive's own **`trailing`** slot (the notification drawer's unread count uses it)          | inactive `--el-text-secondary`; active `--el-tabnav-active` | `text-[11px] font-semibold tabular-nums`                              |
| the group's a11y name | `role="group"` + `aria-label`                                                                     | —                                                           | not rendered visually                                                 |

- **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*`.** Every value above is a
  token the primitive already reaches for; the mock restates their VALUES only because it renders
  without the Tailwind build, as every asset in this area does.
- **The segment radius NESTS**: `calc(var(--radius-btn) - 2px)` against a 2px inset, so the control
  stays right when a style pills `--radius-btn`. That is the primitive's rule, not a new one.
- **How the selection is ANNOUNCED.** Each tab is a `<button aria-pressed>`, so a screen reader says
  _"Planned, toggle button, pressed"_. This is deliberately **not** an ARIA `tablist`: the panel
  below is not a tabpanel whose content is swapped client-side — the tab is a URL-addressable FILTER
  over a server-rendered list, and `aria-pressed` describes a filter honestly where `aria-selected`
  would promise a tabpanel relationship the DOM does not have. It is also what the shipped primitive
  already does everywhere else in the product (the board group-by, the Children List/Graph
  switcher), so the grammar is one grammar.
- **The URL carries the tab.** The strip's state is a query parameter, not component state, so a tab
  is linkable and survives a reload — [the tabbed-list card](motir:cmt1lba4800cji3phjm6pvixz) owns
  the parameter's name and its default.
- **Placement: BELOW the header, above the list.** It is a filter over the list, not a property of
  the page. In the header's right slot it would compete with the slot §5 just emptied, and it would
  break the reading order a screen reader takes: title → subtitle → filter → results.

### The below-`sm` disposition, MEASURED (panel 4)

| box                                           | strip            | verdict                   |
| --------------------------------------------- | ---------------- | ------------------------- |
| 343px (a 375px viewport − the shell's `px-4`) | 310.3px, labels  | **fits**, 32.7px to spare |
| the same 343px box                            | 358.8px, +counts | **overflows by 15.8px**   |
| 592px (a 640px viewport − `sm:px-6`)          | 358.8px, +counts | fits, 233px to spare      |

**So all four tabs keep their LABELS at every width, and the COUNTS render from `sm` up.** The
number decides it, not taste:

- **Not a horizontal scroller.** The fourth tab would sit off-screen on the one surface whose job is
  to show you which statuses exist — and `Declined`, the tab that would be hidden, is the one a
  reader reaches for when reconstructing what happened.
- **Not condensed to glyphs.** Four lifecycle states have no four icons a reader could tell apart;
  the status pills already carry glyphs and they are recognised BY their labels.
- **Not a `<select>` below `sm`.** A second control grammar for one breakpoint is two things to
  build, test and translate.
- **The counts are the right thing to drop** because they are an ORNAMENT on a filter: the number a
  tab promises is supplied by the result set the moment you press it. A count of **zero** still
  renders (`Declined 0`) wherever counts render at all — a tab that silently loses its number reads
  as a loading state, and the zero is a fact worth telling a reader before they press.

## 5. The header carries ONE Plan-with-AI entrance

`app/(authed)/plans/page.tsx` renders a `PlanWithAILauncher` in its header's right slot, and
`TopNav` renders one on every authed screen — two entrances to the same thing, a few hundred pixels
apart. **The page header's goes.** Panel 1 draws the header without it: `<h1>` + subtitle,
and nothing in the right slot.

**The EMPTY state's CTA STAYS.** `/roadmap`'s empty state carries the same one and the two must not
diverge; an empty page also has no populated surface for the top bar's entrance to sit in context
with, and the empty state is exactly where a first-time reader needs the door drawn for them.

## 6. Two EMPTINESSES, and they must not say the same thing

| state                        | when                                       | copy                                                        | CTA                         |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------- | --------------------------- |
| **the project has no plans** | the unfiltered project holds zero plans    | `aiPlanning.emptyTitle` / `emptyDescription`, unchanged     | **Plan with AI** — retained |
| **this TAB has none**        | the project HAS plans, none in this status | `aiPlanning.tabEmpty.<status>Title` / `tabEmptyDescription` | **none**                    |

- **The whole-surface state is the shipped `EmptyState`, untouched** — same glyph, same strings,
  same CTA, reached exactly as it is today. **The tab strip is HIDDEN there**: there is nothing to
  filter, and four zeroes are four ways of saying the same thing.
- **An empty TAB keeps the strip above it** and offers no generate CTA. Repeating _Generate your
  first plan_ would be false on its face, and a generate CTA is the wrong answer to _nothing is
  generating_ — the reader's next move is a different tab, so the copy names where the plans
  actually are (_"Approved and Declined hold this project's history"_).
- **The strip is never hidden by an empty tab.** Hiding the control that got you there is how a
  reader gets stuck in a tab.

## 7. Copy — every string this Part introduces (namespace `aiPlanning`)

Both catalogues are owed — `messages/en.json` AND `messages/zh.json` (the zh-parity gate). The four
tab labels REUSE the shipped `aiPlanning.status.*` strings rather than adding a second set of words
for the same four states.

| key                        | en                                                                               |
| -------------------------- | -------------------------------------------------------------------------------- |
| `statusFilterAria`         | Filter plans by status                                                           |
| `tabEmpty.generatingTitle` | Nothing generating                                                               |
| `tabEmpty.plannedTitle`    | Nothing waiting on you                                                           |
| `tabEmpty.approvedTitle`   | Nothing approved yet                                                             |
| `tabEmpty.declinedTitle`   | Nothing declined                                                                 |
| `tabEmpty.description`     | This project's other plans are in the remaining tabs.                            |
| `decidedBy`                | {verb} {when} by {name} _(the existing `approvedAt` / `declinedAt` with a name)_ |

The decided-row string is a **variant of the shipped `approvedAt` / `declinedAt` keys, not a new
grammar**: `approved {when}` gains `approvedByName` → `approved {when} by {name}`, and the row picks
the plain key when `decidedByName` is null. That keeps the _absence, never a placeholder_ rule a
choice between two whole sentences rather than a name-shaped hole in one.

## 8. GIVES / TAKES

**TAKES — from other Parts and cards** (premises as well as elements):

- **Part III §3's _A DECIDED row shows the DECIDER_ rule — a PREMISE, and it is REVERSED** (§3).
  Amended on the record above, with the superseded text quoted and the reason it failed named.
- **Part III §4's inks, avatar and glyph treatment — an ELEMENT set, unchanged.** The requester's
  entry is byte-for-byte Part III's.
- **Part III's _absence, never a placeholder_ rule — a PREMISE, EXTENDED** to the decider (§3).
- **Part I panel A's `approved … by <name>` drawing — an ELEMENT**, which this Part finally makes
  buildable rather than aspirational.
- **Part I §5's left-nav access path and the row's `<Link>` — STRUCTURE, untouched.**
- **The page header's `PlanWithAILauncher` — a PREMISE removed** (§5): _the Plans page offers its
  own AI entrance_ stops being true. `TopNav`'s and the empty state's remain.
- **[MOTIR-2373](motir:cmsinu308000404la81khtv8y)'s below-`md` measurement discipline — a PREMISE**:
  a width claim is asserted only with a render behind it (§2, §4).
- **[MOTIR-3189](motir:cmt0sn4qq01hni2phocm94qwc)'s `decisionReason` decision — a PREMISE**: the tab
  set is the four-member enum and gains nothing.
- **[MOTIR-3236](motir:cmt1lba3600cii3phn69q6h8h)'s sibling — the null-decider STATE** row 8 draws
  (`decidedById` NULL on an abandoned plan).

**GIVES — to the cards built to this Part:**

- **[The tabbed, streamed list](motir:cmt1lba4800cji3phjm6pvixz)** takes the strip (§4), its
  primitive, its tokens, its a11y contract, its placement, the counts-from-`sm` rule, and both
  empty states (§6). It owns the URL parameter's name and the ten-a-page streaming this Part does
  not draw.
- **[The decided row](motir:cmt1lba1600cgi3ph9crmidd1)** takes §3 whole: the requester restored to
  the attribution entry, the decider BUILT into the when-entry, and the null-decider fallback.
- **[The header pill](motir:cmt1lba0000cfi3ph0gdrpk6n)** takes §5, including the explicit
  instruction that the empty state's CTA is retained.

## 9. What Part VII does NOT draw

The plan DETAIL surface and its List ↔ Canvas switcher (Part VIII); the canvas, its arrival level,
its breadcrumb and the Show-changes control (Part IX); the review rail; the establish band; the
left-nav entry itself; the row's own shape, its pills and its staleness flag; the ten-a-page
streaming mechanics and the scroll sentinel (drawn nowhere — they have no pixels of their own
beyond the list this Part already shows).

---

# Part VIII — The plan DETAIL: a LIST beside the canvas, and what a `generating` plan offers (MOTIR-3234 / Story MOTIR-3232)

**Its OWN asset**: `design/ai-planning/plan-detail-list-view.mock.html` + `plan-detail-list-view.png`,
four panels, plus this section in the area's shared `design-notes.md`.

**It does NOT amend `plans-surface.mock.html`, and that asset is not re-exported** — see _A design
result is a MOMENT_ above. Everything it composes from that asset — the canvas, the three `op`
languages, the decided node treatments, the establish band, the review rail — it composes by
CITATION, drawn there and not redrawn here.

It draws the `/plans/[id]` DETAIL surface and nothing else. The LIST surface is
[Part VII](motir:cmt1lb9t600cbi3ph3fd7qqkk)'s; the CANVAS's own behaviour — which level it arrives
at, the crumb for a proposed parent, and the **Show changes** control — is **Part IX**'s.

## 0. Why a list at all

A canvas is the right way to see **SHAPE**: where a proposal lands, what it hangs under, what blocks
what. It is a poor way to answer _"what exactly am I approving?"_, which is a question about a
**SET** — these cards get created, these get changed, this one gets archived. The work-item detail
already learned this and shipped a **List ↔ Graph** switcher on its Children section
(`design/work-items/child-panel-graph.*`, MOTIR-2284 / MOTIR-2285). **The plan detail is the same
reader asking the same question about a different tree, so it gets the same answer rather than a
second invention.**

**The list is a SECOND BODY in the same pane, never a re-drawing of the first.**

## 1. What this COMPOSES and must not redraw

`PlanReviewCanvas` / `ProjectRoadmapCanvas` / `WorkItemNode` / `PlanItemNode`; the three `op`
languages from Part I §3 panel B; the accepted / declined node treatments and the after-approve pane
from **Part VI**; the per-level drill-down and its breadcrumb; the review RAIL's whole layout; the
establish band. All composed as drawn.

### What it copies from the shipped List ↔ Graph grammar, and what it deliberately does differently

|                        | `child-panel-graph` (MOTIR-2284/2285)                            | Part VIII                                                                                                           |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| the switcher primitive | the shipped `Segmented`, `role="group"` + `aria-pressed`         | **same, unchanged**                                                                                                 |
| where it sits          | the section card's `headerRight` — a header that already existed | **a NEW 44px pane header**, because the canvas pane has none (§2)                                                   |
| which view is DEFAULT  | **LIST**, fixed                                                  | **conditional — Part IX's rule** (§2), cited not restated                                                           |
| the URL carries it     | `?children=graph`                                                | **yes**, same convention                                                                                            |
| the list body          | the SERVER-rendered `ChildList`, byte for byte                   | **its ROW grammar**, with the plan's own op language on top (§3)                                                    |
| the canvas box         | a fixed `h-[28rem]` inside a scrolling content column            | **not applicable** — the plan detail's pane is already a fitted two-pane workspace, and the canvas already fills it |

## 2. Panel 1 — the PANE HEADER and the switcher

**The pane had no header.** `PlanningWorkspace`'s `canvas` slot is filled edge to edge, and an
approved plan stacks the establish band above the canvas (Part VI §4). So a header had to be
DECIDED, not found.

**A 44px bar at the very top of the canvas pane, above the establish band.** `--el-surface`, a
bottom hairline (`--el-border`), `--spacing-control-x` gutters. It holds the switcher at its LEFT
and leaves its RIGHT end for Part IX's control.

**Why above the band, not between the band and the body:** the bar governs the BODY, and the band is
not part of the body. Part VI decided the establish step STACKS above the canvas rather than
replacing it; a control bar underneath the band would make the band read as chrome belonging to one
of the two views. Above both, it is the pane's own control bar, and the band keeps its position
relative to the body it precedes. **Nothing inside the step changes** — MOTIR-1782 keeps every
decision it made.

| element               | primitive                                                   | colour token                                      | shape / size                                                          |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| the pane header       | a `<div>` — new chrome, no primitive                        | `--el-surface`, bottom border `--el-border`       | 44px, `--spacing-control-x` gutters                                   |
| the switcher          | the shipped **`Segmented`**                                 | track `--el-tabnav-track`, border `--el-border`   | `--radius-btn`, 2px inset                                             |
| one option            | its `<button aria-pressed>`                                 | inactive `--el-text-secondary`, hover `--el-text` | `--height-control`, `--spacing-control-x`, `calc(--radius-btn - 2px)` |
| the SELECTED option   | the same button                                             | fill `--el-page-bg`, ink `--el-text-strong`       | `--shadow-subtle`                                                     |
| the group's a11y name | `role="group"` + `aria-label` = `planReview.viewSwitchAria` | —                                                 | not rendered                                                          |

- **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*`.**
- **Both states are drawn** — panel 1 with `Canvas` selected, panel 2 with `List`.

### ⚠️ Part VIII does NOT decide which view is DEFAULT

**The default is a CONDITIONAL rule, and Part IX specifies it**: the canvas by default, the LIST
when the plan's proposals straddle more than one container. That condition is a statement about the
plan's SHAPE, and Part IX is the Part that reasons about shape. **Part VIII cites it and does not
restate it**, so the two Parts cannot drift into two answers. What Part VIII owns is everything
else about the control: its placement, its primitive, its tokens, its selected treatment, its
accessible group name, what it does to the establish band (nothing), and what **both** of its states
look like — which is why both are drawn.

### The place Part IX's control occupies

**The right end of the pane header, opposite the switcher.** Panels 1 and 2 draw it as a dashed
placeholder carrying Part IX's mark, in both frames. Its behaviour, treatment and states are Part
IX's to specify; Part VIII specifies only WHERE it goes, so the pane's chrome is decided once
rather than twice. Leaving it undrawn is how a pane ends up with two control bars.

## 3. Panel 2 — the LIST body, per row and per FIELD

**The row is the shipped `ChildList` row grammar** — kind glyph (`IssueTypeIcon`, its
`--el-type-*` hue), identifier, title, a facts line, a right-hand chip — so a reader who has read
the Children list has read this one. Shape routes through `--radius-control` /
`--spacing-control-x|y`, exactly as that row does.

| element           | reads                                                                         | primitive / treatment                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the kind glyph    | `kind`                                                                        | `IssueTypeIcon`, `--el-type-{epic,story,task,bug,subtask}`                                                                                               |
| the key           | `identifier`                                                                  | the row's monospace key, `--el-text-identifier`; **`no key yet`** in `--el-text-secondary` for an un-materialized `add` (⚠️ AMENDED — MOTIR-4277, below) |
| the title         | `title`                                                                       | the row's title ink, single-line ellipsis                                                                                                                |
| the facts line    | `kind` · `type` · `storyPoints` · `estimateMinutes` · `targetRepo`            | `--el-text-secondary`, the row's own `text-xs`                                                                                                           |
| where it lands    | `parentIdentifier` / `parentTitle`, or `parentNodeId` naming another proposal | `under <b>…</b>`; an INTRA-PLAN parent is marked _(proposed)_                                                                                            |
| the live status   | `statusLabel` / `statusCategory`                                              | the shipped `StatusPill` — only where the row HAS one (never an `add`)                                                                                   |
| the op            | `op`                                                                          | panel B's own `add` / `modify` / `remove` chips, unchanged                                                                                               |
| the stale flag    | `stale` / `staleReasons`                                                      | the row's shipped warning `Pill`, as the rail draws it                                                                                                   |
| a `modify`'s diff | `changes[]`                                                                   | §3's two-line text form, below                                                                                                                           |

- **An `add` has NO KEY, and the list says so rather than leaving a gap.** `identifier` is null until
  approve materializes it. An empty slot in a column of keys reads as a missing value; `no key yet`
  reads as the fact it is. ~~(`--el-text-faint` is legitimate here — it is a LABEL about absence
  beside a value the row also carries in words, and the row's meaning does not depend on it. Where
  it must carry meaning alone, use `--el-text-secondary`.)~~ **⚠️ AMENDED (MOTIR-4277): it is
  `--el-text-secondary`, by this sentence's OWN test.** Nothing else occupies that slot — the row
  carries the key or it carries `no key yet` — so the label DOES carry its meaning alone, which is
  the case the parenthetical already routed to `--el-text-secondary`. The clause that read the
  other way was written about a row where the absence is also legible from the words beside it,
  and this row is not that.
- **A `modify`'s diff is TWO-LINE TEXT, per changed field — deliberately NOT the canvas's inline
  overlay.** The canvas overlay answers _this node is changing_, inside a node card ~280px wide: it
  is a SIGNAL. The list answers _changing to WHAT_, at the full width of the pane, for a reader
  deciding whether to approve. So **the list is the only surface that spells a change out and the
  canvas is the only surface that marks a node** — neither is built twice.
  - the field NAME in the row's monospace label ink; the OLD value struck through in
    `--el-text-secondary`; an arrow in `--el-text-secondary`; the NEW value in `--el-text-strong`
    at `font-semibold`. (⚠️ AMENDED — MOTIR-4277, below. It read `--el-text-muted` for the old
    value and `--el-text-faint` for the arrow, the arrow "`aria-hidden`, decorative". The asset
    never carried that `aria-hidden`, so the exemption the faint ink depended on was never
    earned — and the strike-through already says _old_ without help from a lighter ink.)
  - **A field whose new value is a BODY (`description`, `explanation`) is NAMED, not quoted** —
    _"rewritten — open the card to read it"_. A rewritten description is not a diff a review list
    can carry, and a truncated one is worse than a pointer.

### ⚠️ What the list says about a `remove` — DECIDED: a THIRD SECTION

A plan holds three ops. **A list showing two of them, under a row whose item count counts all
three, is a surface that contradicts itself** — and the count is on the row that got the reader
here. The request named _the cards it adds and the cards it updates_ because those are the two a
plan usually holds, not as an enumeration of what a list may show.

**So the list renders three sections — `Adds` · `Updates` · `Archives` — each appearing only when
it is non-empty, and the plan's item count keeps its WHOLE-PLAN scope**, which is truthful because
the list now covers the whole plan. An archived row takes panel B's own `remove` treatment: struck
title, muted ink, the archive chip — **nothing red, dashed or hatched**, because archive is
reversible and red-hatch stays reserved for the canvas's cross-story dependency signal.

Rejected: a one-line footnote (_"and 1 card will be archived"_) — it makes the one destructive op
the only one you cannot see; and a count that names its own scope (_"13 of 14"_) — it fixes the
arithmetic and leaves the reader unable to find the fourteenth.

### States

| state       | what it draws                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **empty**   | _No proposals_ — a plan that finished proposing nothing, with the one sentence that matters: _nothing will change if you approve it_ |
| **loading** | the canvas's own centred `Spinner`, in the same box. No second skeleton: the pane has already painted                                |
| **DECIDED** | the list is a **RECORD**, reconciled with Part VI in one sentence — see below                                                        |

**The DECIDED list, reconciled with Part VI.** Part VI decided the canvas pane holds the RECORD of
what was accepted rather than a set of proposals; **the list is the same pane's other body, so it
says the same thing in the same tense** — `Created` / `Applied` / `Archived` rather than
`+ add` / `change` / `archive`, and every row that has a key now shows one. A **declined** plan's
list keeps the proposal tense and adds no outcome chip: nothing happened to those cards.

## 4. Panel 4 — what a plan still GENERATING offers

`plansService.declinePlan` accepts a `generating` plan and records
`decisionReason: 'discarded'` (MOTIR-3189). `PlanReviewRail` renders its Decline button with
`disabled={!planned}` and the hint `reviewLocked`. **The valve exists and has no door** — and the
two plans this story was written about sat at `generating` for the better part of a day with a
control that could have ended them, greyed out.

| decision                                                       | the answer, and why                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **the control**                                                | the rail's SECOND button, in the decision bar where Decline is today — same place, same size, `Button variant="secondary"` (a real affordance, not a ghost: it is the only live control in this state)                                                                                                                                                 |
| **the label**                                                  | **`Discard this plan`**, not _Decline_. Declining is what you do to a finished proposal you have read; a plan that never finished is not being rejected on its merits, it is being ENDED. `Plan.decisionReason` already tells the two apart on the row (`discarded` vs `reviewed`); the button is where a reader learns which one they are doing       |
| **does it confirm?**                                           | **YES.** The shipped `Modal` at `size="sm"` — the same one the stale-approve confirm uses. Approve confirms when items are stale, and this is sharper: the action is irreversible from this surface and the plan is still moving                                                                                                                       |
| **what the confirm says about the proposals already appended** | it NAMES them: _"It has **3 proposals** so far and is still being written. Discarding ends it now and keeps the proposals as a record — nothing in your backlog changes, and nothing is created."_ The count is the one fact that tells the reader what they are throwing away, and the second half is the reassurance the whole substrate is built on |
| **what replaces `reviewLocked`**                               | _"Approve unlocks when generation completes. Discarding ends it now — nothing in your backlog changes."_ The old hint (_"Review & Approve unlock when generation completes"_) was true of both buttons and is now true of one; **a hint under two buttons that describes only one is how the live control reads as disabled too**                      |
| **who may press it**                                           | UNCHANGED — `ai:decide_plan`, exactly as it gates approve. A reader without it sees the rail without the control, as they do today                                                                                                                                                                                                                     |

**Approve stays disabled.** Nothing about this widens what may be approved: a plan that has not
finished generating is not a plan anybody should be materializing, and that is the half of
`reviewLocked` that was always right.

## 5. Copy — every string these panels introduce (namespace `planReview`)

Both catalogues are owed — `messages/en.json` AND `messages/zh.json` (the zh-parity gate).

| key                                            | en                                                                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewSwitchAria`                               | Plan view                                                                                                                                                                                                         |
| `viewList`                                     | List                                                                                                                                                                                                              |
| `viewCanvas`                                   | Canvas                                                                                                                                                                                                            |
| `listAdds`                                     | Adds                                                                                                                                                                                                              |
| `listUpdates`                                  | Updates                                                                                                                                                                                                           |
| `listArchives`                                 | Archives                                                                                                                                                                                                          |
| `listCreated` / `listApplied` / `listArchived` | Created / Applied / Archived                                                                                                                                                                                      |
| `listNoKey`                                    | no key yet                                                                                                                                                                                                        |
| `listProposedParent`                           | (proposed)                                                                                                                                                                                                        |
| `listBodyRewritten`                            | rewritten — open the card to read it                                                                                                                                                                              |
| `listEmptyTitle`                               | No proposals                                                                                                                                                                                                      |
| `listEmptyBody`                                | This plan finished without proposing anything. Nothing will change if you approve it.                                                                                                                             |
| `discardCta`                                   | Discard this plan                                                                                                                                                                                                 |
| `discardHint`                                  | Approve unlocks when generation completes. Discarding ends it now — nothing in your backlog changes.                                                                                                              |
| `discardConfirmTitle`                          | Discard this plan?                                                                                                                                                                                                |
| `discardConfirmBody`                           | It has {n, plural, one {# proposal} other {# proposals}} so far and is still being written. Discarding ends it now and keeps the proposals as a record — nothing in your backlog changes, and nothing is created. |
| `discardConfirmCancel`                         | Keep generating                                                                                                                                                                                                   |
| `discardConfirmCta`                            | Discard plan                                                                                                                                                                                                      |

## 6. GIVES / TAKES

**TAKES** (premises as well as elements):

- **Part VI §4's _the establish step STACKS above the canvas_ — a PREMISE, honoured**: the pane
  header goes ABOVE the band precisely so that relationship is not disturbed (§2).
- **Part VI's _the decided pane holds a RECORD_ — a PREMISE, EXTENDED to the list** (§3's decided
  state), which is why the list changes tense rather than greying out its op chips.
- **Part I §3 panel B's three `op` languages — an ELEMENT set, unchanged.** The list introduces no
  fourth language for the same three facts.
- **[Part IX](motir-ref:cmt1ui496002zi1n8qe3uzt1k)'s _which view is DEFAULT_ — a PREMISE this Part
  DOES NOT DECIDE** (§2). Part IX also TAKES this Part's pane-header slot for its Show-changes
  control — a STRUCTURE this Part reserves and labels.
- **`PlanReviewRail`'s _a plan that is not `planned` offers nothing_ — a PREMISE, REVERSED for one
  control** (§4). It was true when nothing could act on a `generating` plan; MOTIR-3189 made that
  false and the rail did not follow.
- **MOTIR-2284 / MOTIR-2285's List ↔ Graph grammar — STRUCTURE**, cited in §1's table with what is
  copied and what is deliberately different.
- **`ChildList`'s row — an ELEMENT**, composed rather than redrawn.

**GIVES:**

- **[The plan-detail list view](motir:cmt1lba2700chi3phgktf5gn8)** takes §2's pane header and
  switcher and §3 whole: the row per field, the `modify` diff form, the three sections, and the
  empty / loading / decided states. It takes the DEFAULT rule from **Part IX**, not from here.
- **[The discard valve](motir:cmt1lba3600cii3phn69q6h8h)** takes §4 whole: the control, its label,
  its confirm, the replaced hint, and the unchanged permission.
- **Part IX** takes the pane-header slot (§2) and owes the control that fills it.

## 7. What Part VIII does NOT draw

The canvas and its node treatments; **which level the canvas arrives at**; **the breadcrumb crumb
for a PROPOSED parent**; **the Show-changes control's own behaviour and treatment** — all three are
Part IX's. Also: the drill-down, the review rail's layout, the establish step's own content, the
approve/decline flow for a `planned` plan, and the `/plans` list surface (Part VII).

## 8. ⚠️ AMENDMENT — the asset now consumes the `--el-*` layer, and three inks moved with it (MOTIR-4277)

**The asset's `:root` used to alias the design system's values onto PRIVATE names** — `--muted:
#787671`, `--faint: #a4a097`, `--soft: #fafaf9`, and eleven more. Every value was correct, copied
from the token layer at some past moment, which is exactly what made it look harmless. What a raw
hex cannot do is flip with `data-palette`, follow a re-skin, or be MEASURED: every ink guard in the
tree keys on `--el-*`, so an asset that aliases hexes is outside all of them by construction.

**What that hid.** `.prow:hover` paints `--soft` and the row's monospace key was inked `--muted`:
`#787671` on `#fafaf9` is **4.34:1**, the exact pairing `CLAUDE.md`'s measured table forbids and the
exact pairing [MOTIR-4255](motir:cmtkyfo51007bhvn88k9qcooo) had just swept out of 22 other assets —
here, under a green `design-ink-contrast`. Sixteen elements in this asset failed 4.5:1 under that
hover tint. The state arm could only COUNT them (`unTokenisedInkCount`), because the remedy it
applies is a token SWAP and there was no token to swap.

**Three inks moved, and each is the token that names the job:**

| element                                                            | was                                             | is                         | why                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| the row's monospace key (`.prow .ttl .key`)                        | `--el-text-muted` (4.34:1 under the hover tint) | **`--el-text-identifier`** | the token `theme.css` names for a monospace item key                                                                      |
| `no key yet` (`.prow .ttl .nokey`)                                 | `--el-text-faint` (2.50:1)                      | **`--el-text-secondary`**  | §3's own test: nothing else fills that slot, so the label carries its meaning alone                                       |
| a `modify`'s OLD value and its arrow (`.chg .from`, `.chg .arrow`) | `--el-text-muted` / `--el-text-faint`           | **`--el-text-secondary`**  | the strike-through already says _old_; the arrow's `aria-hidden` exemption was specified but never written into the asset |

The same swap moved every other ink, fill, border and radius in the asset onto `--el-*` /
element-semantic shape tokens. Three values changed as a consequence of consuming the layer rather
than a copy of it, and all three are named in the pull request: the review sheet's backdrop and the
tab track/pressed pair (the asset's own §2 comment already named `--el-tabnav-track` and
`--el-page-bg`, and the aliases had them inverted), `--el-border-strong` (`#d3cfc8` → `#c8c4be`),
and the tint CHIP inks, which take `--el-text-strong` per `CLAUDE.md`'s coloured-chip rule instead
of six hand-darkened hues. **The `.png` is re-exported at unchanged dimensions.**

**The asset has no `[data-theme='dark']` block and did not gain one** — it is a light-only board, so
`design-dark-parity` has nothing here to rule on; the tokens it now consumes are the ones that would
carry a dark block if one is ever drawn.

---

# Part IX — The plan-detail CANVAS at arrival, and SHOW CHANGES (MOTIR-3259 / Story MOTIR-3232)

**Its OWN asset**: `design/ai-planning/plan-canvas-arrival.mock.html` + `plan-canvas-arrival.png`,
four panels, plus this section.

Part VIII gave the plan-detail pane a second BODY. **Part IX is the first body's BEHAVIOUR** — what
the canvas does when it opens, and one control it does not have.

**It draws NO new surface.** `/plans/[id]` is reached exactly as Part I §5 draws it — the left-nav
_Plans_ entry, then a row — and this Part adds no entrance. It does not amend
`plans-surface.mock.html`; the canvas, its node cards and the three `op` languages are composed as
that asset draws them.

## 0. The CONTRACT this Part must design to

`ProjectRoadmapCanvas` (MOTIR-1194) is the reusable foundation five surfaces mount, driven by
`PlanningCanvas`. Its shape constrains what may be drawn here:

- **PRESENTATIONAL and PER-LEVEL.** It owns no fetching; the consumer supplies `loadLevel(parentId)`
  and it renders exactly one level. **A panel that drew the whole proposed tree at once would be
  un-buildable against it** — so whatever Show changes does, it does to the level in view (§L5 is
  that consequence, faced rather than worked around).
- **It ARRIVES where the consumer tells it**, via `initialTrail` — read ONCE at mount, a seed and not
  a controlled level. Panel 1 is a decision about that seed and never about hijacking navigation.
- **The breadcrumb** is the trail plus a root crumb the consumer labels (`roadmap.canvas.breadcrumbRoot`,
  bug MOTIR-3152).
- **The top-right cluster** holds the search box and the full-screen toggle, gated on `searchable` /
  `fullScreenable`. §L1 is what this Part does about a third control wanting chrome.

## 1. Panel 1 — WHERE THE CANVAS ARRIVES

### The defect, read on `origin/main` @ `b820c979`

Two shipped facts meet, and each is right on its own:

1. `arrivalLevel(items)` counts proposals per parent and takes the largest — but its loop opens
   `if (!item.parentNodeId || !item.parentIdentifier) continue;`.
2. `planReviewService.getPlanReview` sets `parentIdentifier` (with `parentTitle`, `parentKind` and
   `parentTrail: []`) to **null for an intra-plan `planItem:` parent** — deliberately, because
   _"an intra-plan parent already has a node in the proposed set, so the canvas draws it and the
   breadcrumb does not."_ **`parentNodeId` IS populated** for those items.

**So (1) discards exactly the items (2) describes.** A plan proposing one story under a committed
epic plus five subtasks under that story counts ONE edge and opens on the **epic**, drawing the
proposed story as one card among its committed siblings. Panel 1 draws that BEFORE beside the AFTER,
because the change is invisible in a single frame.

### The five decisions

1. **The arrival rule.** The canvas opens on the level the plan most FILLS, counting proposals under
   PROPOSED containers as well as committed ones — i.e. count `parentNodeId` for every proposal.
   **What this changes:** the plan that proposes a container AND its contents, which is the shape an
   agent-authored skeleton produces almost every time. **What it does not:** a plan of pure roots
   still opens at the top level; a plan whose proposals all sit under one committed parent still
   opens there.
2. **The TIE-BREAK is the DEEPER level.** One story under an epic plus one subtask under that story
   is 1–1, and the shipped code keeps whichever level the `Map` yielded first — an accident, not a
   decision. Prefer the deeper: **a reviewer wants to land where the work is, and the shallower level
   is one Back away while the deeper one is a drill they must first discover.** Depth is the length
   of the arrival trail, which the same pass already builds.
3. **The CRUMB for a proposed parent — `New · <title>`.** A committed crumb is `KEY · Title`
   (`workItemCrumbLabel`); an un-materialized `add` has `identifier: null` **by construction**, and a
   placeholder key (`MOTIR-?`, `#new-3`) would assert a work item that does not exist — on the one
   surface whose whole promise is that nothing is real until approve. So the crumb keeps the grammar
   and puts the WORD `New` in the slot the key would occupy. **The distinction is TEXT first**, with
   the accent ink, the dashed border and the `+` glyph as second and third channels — never colour
   alone.
4. **A level that is ENTIRELY proposed.** Drilling into a proposed container asks the roadmap for the
   children of an id no work item has; `fetchRoadmapLevel` is best-effort and resolves an empty
   committed level, so the proposals render alone. That is correct and looks like nothing else on
   this surface, so **the level caption says why** — in the shipped `lvlcap` slot — and an
   empty-looking canvas is not read as a failed load.
5. **The DEGRADE.** An archived or hard-deleted ancestor gives `parentTrail: []` beside a non-null
   `parentNodeId`, and the shipped code already degrades to one synthesised crumb. When the parent is
   ITSELF proposed there is no committed chain to synthesise from at all, so the trail is the
   canvas's own ROOT crumb plus the proposed crumb. **The canvas never arrives with no breadcrumb**,
   and Back always leads somewhere real.

## 2. Panels 3–4 — SHOW CHANGES

### §L1 · Placement — the CANVAS's own cluster, and Part VIII's reserved slot is RELEASED

**Part VIII reserved the right end of its new pane header for this control, and Part IX does not take
it.** The toggle goes in `ProjectRoadmapCanvas`'s **top-right cluster**, beside the search box and
the full-screen button. Three reasons, in order:

- **It acts on the canvas's nodes and belongs adjacent to what it changes.** The pane header sits
  above a body that may be the LIST, where this control means nothing.
- **It must not exist in the list view**, and the canvas's own cluster gets that for free — no
  conditional chrome in a header that belongs to both bodies.
- **The emphasis state lives in the foundation.** The prop carrying the emphasised ids is
  `ProjectRoadmapCanvas`'s (opt-in, defaulting to absent, exactly as `searchable` / `fullScreenable`
  / `locatable` are); a control in a different component would have to lift that state out of the
  component that owns it.

**Part VIII's panel 1 draws a dashed placeholder in the pane header labelled for this Part. That
placeholder is not built.** It is recorded here rather than by re-exporting Part VIII's asset — that
asset records the moment it was drawn, and this note is the correction a reader needs (see _A design
result is a MOMENT_). The pane header therefore holds the switcher alone.

**Per element:** the shipped full-screen button's shell — `--el-surface` fill, `--el-border`,
`--radius-btn`, `--height-control`, `--shadow-card` — widened for a label, because this control has
no icon a reader could guess. Resting ink `--el-text-secondary`; ~~ACTIVE takes `--el-accent-soft` fill~~
**⚠️ CORRECTED (Part XIII §3e, MOTIR-4017): `--el-accent-soft` IS DEFINED NOWHERE.** It was a LOCAL
variable in this Part's own mock (`plan-canvas-arrival.mock.html:36`, `#f4f2fd` — a hex that appears in
neither `theme.css` nor `globals.css`), transcribed into the `--el-*` namespace here and then built
faithfully at `ProjectRoadmapCanvas.tsx:1087`. The declaration is dropped as invalid, so the pressed
toggle rendered with **no background at all** — measured `rgba(0, 0, 0, 0)`. **The ACTIVE fill is
`--el-tint-lavender`**, with `--el-accent` border and `--el-accent-on-surface` ink; DISABLED is the same
shell at reduced opacity. A real
`<button>` carrying `aria-pressed`. **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` /
`h-*`.**

> **⚠️ AMENDED 2026-09-03 (MOTIR-4349) — the LOCAL declaration the sentence above cites no longer
> exists, and neither does the line it cites it at.** `plan-canvas-arrival.mock.html` has been
> re-pointed at the `--el-*` element-token layer: its `:root` no longer aliases the design system's
> values onto private names, so there is no `--accent-soft: #f4f2fd` at `:36` or anywhere else. The
> wash that hex drew is now **`--el-accent-wash`**, declared as
> `color-mix(in srgb, var(--el-accent) 6%, var(--el-page-bg))` — both inputs are tokens, so it
> re-tints with `data-palette` instead of freezing one palette's purple.
> **The correction the sentence makes is UNCHANGED and still binding**: `--el-accent-soft` is
> defined nowhere, the ACTIVE fill is `--el-tint-lavender`, and a mock-local name must never be
> transcribed into the `--el-*` namespace. What changed is only that this asset no longer HAS a
> mock-local colour name to transcribe — which is the class fix, not a reason to re-read the
> decision above.

### §L2 · The SET, and why it is orthogonal to the op languages

**Every proposal on the level in view, whatever its `op`** — `add`, `modify` and `remove` alike,
which is what the request's _added / updated / archived_ names. A `modify` or `remove` shares its node
id with the committed card it targets, so the ring lands ON that card rather than beside it.

**The op languages from Part I §3 panel B stay exactly as they are: they say WHICH change this is,
and the emphasis says THAT there is one.** They are orthogonal, and neither is an alternative to the
other — a build card must not read this as a choice.

### §L3 · The treatment — the SHIPPED ring and the SHIPPED dim

`ProjectRoadmapCanvas`'s node wrapper already rings a selected or search-matched node
(`ring-2 ring-(--el-accent) ring-offset-2 ring-offset-(--el-surface-soft)`) and already dims
everything outside the connected set (`opacity-35`). **Show changes applies that same pair to a SET.**
One ring value, one dim value, one vocabulary; no second highlight language.

**The dim stays at the shipped 35%, not lower.** A committed sibling is on this canvas for a reason —
_"seeing the company a proposed card will keep is most of what 'is this the right place for it?'
means"_ (`planLevel.tsx`) — so dimming it to invisibility would defeat the level the emphasis exists
to read.

### §L4 · A live SELECTION WINS, and the toggle stays pressed

Selecting a card already dims everything unconnected to it, and both mechanisms write the same
`connectedIds`-shaped state. Layering them gives three opacity tiers and no legible meaning. So the
**selection wins for as long as it lasts** — a proposed card outside the selection's connected set is
dimmed like any other. The toggle stays `aria-pressed`, so clearing the selection restores the
emphasis rather than making the reader re-arm it. **A selection is a momentary act; the toggle is a
mode, and a mode should survive one.**

### §L5 · The plan's cards that are NOT on this level — a COUNT, and no navigation

The canvas is per-level; a plan spread over three parents has most of itself off-screen. **The control
reads `3 of 11` whenever the level holds fewer than the plan's total, and stops there.** It offers no
way to reach the rest, deliberately: **the way to the other eight is Part VIII's LIST**, which is the
whole reason that body exists. A second navigation affordance here would be a worse answer to the
same question, in the pane that already has the better one.

### §L6 · The degenerate levels

- **A level with NO proposals** (the reviewer drilled elsewhere): the toggle is **disabled**, with
  `title` and accessible description _"No proposed changes on this level"_. An ON state would dim
  every card and ring none — a screen that says nothing, which is worse than a control that says why
  it cannot help.
- **A level that is ENTIRELY the plan's**: ~~enabled, and ON simply rings everything with nothing to
  dim. Correct and harmless, not special-cased~~ — **⚠️ REVERSED by Part XIII §3d (MOTIR-4017): DISABLED,
  with its own reason (`planReview.showChangesAll`).** _Harmless_ was a property of a state the reader
  CHOSE. Once the emphasis is ARMED ON ARRIVAL the same state arrives unasked — every card ringed, none
  dimmed — and a ring that is on everything teaches the reader, at the moment they land, that the ring
  means nothing. That is this bullet's own argument for the empty case, applied to its mirror. The count
  reading `4 of 4` is still the honest thing to say about the level, and the level CAPTION says it.

### §L7 · A DECIDED plan — the control SURVIVES, in the past tense

Part VI made this pane a RECORD after the decision. **"What did this plan change?" is a better
question after approve than before** — the cards are real now and sit among neighbours that were
always there — so the control stays and its label moves to the past tense (_Show what changed_). On a
DECLINED plan it stays too, reading the same: the record is of what the plan _would_ have changed, and
the reader is asking the same thing.

### §L8 · a11y and motion

The toggle is a real button carrying `aria-pressed`, so its state is announced rather than inferred
from its fill; disabled, it carries the reason as its accessible description. **The emphasis is never
colour alone** — a ringed node also carries its own `op` badge, which is TEXT (`add` / `change` /
`archive`), and the dim is a second non-hue channel. And because turning this on changes the opacity
of most of the screen at once, **the transition is dropped entirely under
`prefers-reduced-motion: reduce`**: the state changes instantly rather than fading.

## 3. The conditional DEFAULT VIEW — the rule Part VIII defers to this Part

**The canvas by default; the LIST when the plan's proposals sit under MORE THAN ONE distinct
parent.**

> **⚠️ WIDENED, not replaced, by Part XIII §6 (MOTIR-4017).** This arm is kept verbatim and TWO are
> added ahead of it: an arrival level whose untruncated total exceeds `TREE_LEVEL_MAX_TAKE`, and an
> arrival level of more than **12** nodes. Part XIII §6 also MEASURES that `ARRIVAL_MIN_SCALE = 0.80`
> is unreachable on this surface at three of four viewports — the rail leaves the canvas 782px wide at
> 1440×900 against a 1000px world box — which is why its predicate is a node COUNT and not a scale.

- **What counts as a container:** a distinct `parentNodeId`, whether that parent is committed or
  itself proposed. **`null` — a root proposal — counts as ONE container, the top level**, so a plan of
  pure roots has exactly one and opens on the canvas.
- **Why:** a straddling plan has no single level that can show it, and the canvas shows one level at a
  time. Opening on it is the surface insisting on a view that structurally cannot answer the question.
  The list already exists by then, and making it the default in that one case is the cheapest of the
  three fixes here and the one that admits the most.
- **The switcher itself is Part VIII's.** This Part decides only which option is preselected — and
  Part VIII cites this section rather than restating it, so the two cannot drift into two answers.
- **The URL contract is unchanged:** the default writes a CLEAN url with no parameter, whatever the
  default is, so every existing `/plans/[id]` link stays byte-identical.
- **The default is a SEED, read once.** A `generating` plan can cross the one-container threshold
  while a reviewer is looking at it; a later poll must never move them between views.

## 4. The workflow spec this Part draws to — the three build cards

The card required these to be read, not inferred, and this is which behaviour came from which:

| behaviour                                                                                                    | card                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the arrival level, the tie-break, the proposed crumb, the trail synthesis and the degrades                   | **MOTIR-3260** — _the plan canvas OPENS on the level the plan actually fills_, which also ships a pure container-spread module (`planShape`) beside `lib/planning/planReview.ts` |
| the emphasis, its opt-in prop on the foundation, the set, the reset on level change, and the off-level count | **MOTIR-3261** — _SHOW CHANGES on the plan canvas_                                                                                                                               |
| the derived default view                                                                                     | **MOTIR-3262** — _a plan whose proposals STRADDLE containers opens in the LIST view_, which reads the container count from that same module and re-derives nothing               |

Two constraints those cards state that this Part has honoured rather than contradicted: the emphasis
prop is **opt-in and the foundation's four other consumers are byte-unchanged**, and the container
count has **exactly one implementation**, in that module, which both the arrival level and the
default view read.

## 5. Copy — every string these panels introduce

Both catalogues are owed (the zh-parity gate). **The namespace splits on WHO owns the string**, which
is the same line the opt-in prop draws:

| key                | namespace        | en                                                                   | why this namespace                                                                      |
| ------------------ | ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `showChanges`      | `roadmap.canvas` | Show changes                                                         | the control lives on the FOUNDATION, which has five consumers                           |
| `showChangesPast`  | `planReview`     | Show what changed                                                    | the past tense is a fact about a decided PLAN, which the foundation knows nothing about |
| `showChangesNone`  | `roadmap.canvas` | No proposed changes on this level                                    | the disabled reason, said by the control                                                |
| `showChangesCount` | `roadmap.canvas` | {n} of {total}                                                       | the count, said by the control                                                          |
| `proposedCrumb`    | `planReview`     | New                                                                  | the key-slot word on a proposed crumb — plan-specific                                   |
| `allProposedLevel` | `planReview`     | Nothing committed here yet — every card on this level is this plan's | the level caption                                                                       |

**The foundation cannot name what "the plan's changes" ARE** — it has no idea it is showing a plan —
so the strings it renders are generic and the plan-specific ones are passed in. That is the same
reason the emphasised ids are a prop rather than something the canvas derives.

## 6. GIVES / TAKES — swept over the story SUBTREE

**TAKES** (premises as well as elements):

- **Part VIII's _which view is DEFAULT_ deferral — a PREMISE.** Part VIII states the default is a
  conditional rule and cites this Part; §3 is that rule.
- **Part VIII's reserved pane-header slot — a STRUCTURE, RELEASED not consumed** (§L1). Part VIII's
  asset draws a placeholder there that is not built; recorded here, with that asset left frozen.
- **Part VI's _the decided pane holds a RECORD_ — a PREMISE, EXTENDED** (§L7): the control survives
  the decision and changes tense.
- **Part V panel E's _a proposal is a normal card on its parent's level_ — a PREMISE this Part
  completes.** Part V made the level right; Part IX makes the ARRIVAL right, which is the same
  argument one step earlier.
- **Part I §3 panel B's three `op` languages — an ELEMENT set, untouched and explicitly orthogonal**
  to the emphasis (§L2).
- **Part I §5's access path — a STRUCTURE, cited.** This Part adds no entrance.
- **`ProjectRoadmapCanvas`'s selected / search-matched ring and `opacity-35` dim — ELEMENTS, reused
  verbatim** (§L3), and its `initialTrail` read-once contract — a PREMISE (§0).
- **MOTIR-3152's breadcrumb-root fix — an ELEMENT** the degrade in §1.5 leans on.

**GIVES:**

- **MOTIR-3260** takes §1 whole: the rule, the tie-break, the crumb, the all-proposed level and both
  degrades.
- **MOTIR-3261** takes §L1–§L8: placement, the prop's shape, the set, the treatment, the selection
  interaction, the count, the two degenerate levels, the decided-plan label and the a11y/motion line.
- **MOTIR-3262** takes §3: the rule, what counts as a container, the pure-roots case, and the
  seed-not-controlled property.
- **Part VIII** gets its reserved slot back, and its switcher stands alone in the pane header.

## 7. What Part IX does NOT draw

The node treatments and the three `op` languages; the drill / Back / search / zoom / full-screen
mechanics; the List ↔ Canvas switcher and the list body (Part VIII's); the review rail; the establish
band; the `/plans` list surface (Part VII's); and any new entrance to this surface.

---

## The streaming allocation at ARRIVAL — `/plans` and `/plans/[id]` (MOTIR-3442)

Part of [MOTIR-3440](motir:cmt8s085i003li1ph06u469kx)'s sweep of the 24 heavy authed surfaces. The
rule this applies is `design/shell/design-notes.md` § _The navigation-pending grammar_ →
_WHICH SURFACES EARN A FRAME_, and the three-tier method is
`design/work-items/design-notes.md` § _The item page at ARRIVAL_'s. **Neither is restated here.**
Measured against `origin/main` `9455fc3c`.

### `/plans` — the list

|                            |                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `searchParams` → `getSession` → `getTranslations('aiPlanning')` → `getActiveProject` → `getCapabilities` (`canBrowse`)                                                                                                                                          |
| **with the frame**         | the `<h1>`, and the status tab strip — the tabs are static route links, not derived from any read                                                                                                                                                               |
| **with the first content** | `Promise.all([listPlans, countPlansByStatus])`, then `buildPlanRowViews(firstPage.plans)`, which **depends on the first** and so is a genuine second wave; the rows and the per-status counts land together                                                     |
| **after the page**         | — nothing                                                                                                                                                                                                                                                       |
| **settles**                | **once.** Both waves are behind one boundary; splitting them would settle the list twice for no reader benefit, because the counts sit ON the tabs above the rows                                                                                               |
| **verdict**                | **NONE — reuse.** The region behind the boundary is a list of `PlanRow`s, and the pending state for a row list is already drawn: `app/(authed)/backlog/_components/BacklogSkeleton.tsx`. The code card composes it as the fallback; this asset draws no new one |

### `/plans/[id]` — the detail

|                            |                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `getSession` → `params` → `getTranslations('planReview')` → `getWorkspaceContext` (**`notFound()`**) → `planReviewService.getPlanReview` (**`notFound()` on `PlanNotFoundError` / `ProjectAccessDeniedError`**)                                                                                           |
| **with the frame**         | the back-link and the `<h1>` — but the title is `review.title`, so **the header is only paintable once the gate's own read returns**, which it must anyway                                                                                                                                                |
| **with the first content** | `assertProjectInWorkspace` → `projectKey`, and — only when `review.status === 'approved'` — `getEstablishView`                                                                                                                                                                                            |
| **after the page**         | — nothing                                                                                                                                                                                                                                                                                                 |
| **settles**                | **once**                                                                                                                                                                                                                                                                                                  |
| **verdict**                | **NONE, and it is CONSTRAINED rather than chosen.** `getPlanReview` decides the 404 **and** supplies the title, the canvas and the chat; once it has returned there is nothing behind it worth a boundary. The two follow-on reads feed the repository-establish strip, which is a strip and not the page |

**The concurrency change here is real and small:** `assertProjectInWorkspace` and `getEstablishView`
are sequenced only because the second is gated on `review.status`; the first can start with the plan
read. **And note what it is not** — the canvas/chat body renders from the `review` the island already
holds, which is why `PlanDetail`'s view switch is `shallowPush` and shows no pending state at all
(`design/shell/design-notes.md` § _THE SWITCH RULE_, unchanged by this sweep).

> ## ⚠️ AMENDMENT — 2026-08-26, MOTIR-3445. TWO CLAUSES ABOVE WERE ASSERTED, NOT MEASURED.
>
> The build card read both pages and found two of this entry's clauses false. The **allocation**
> — the gate, the tiers, the settle count, the verdicts — is unchanged; what was wrong is the
> rendering detail underneath it, in both cases because it was reasoned from the route's shape
> rather than read off the component.
>
> **1. `/plans`' tab strip is NOT paintable with the frame.** The entry says
> _"the status tab strip — the tabs are static route links, not derived from any read"_.
> `PlanStatusTabs` takes `counts`, which comes from the tier-2
> `Promise.all([listPlans, countPlansByStatus])` — and `counts` also decides `projectIsEmpty`,
> which selects whether the page renders the tab strip at all or a project-level `EmptyState`.
> So tier 1 on this page is the `<h1>` and its subtitle, and nothing else.
>
> **2. `BacklogSkeleton` is not a stand-in for a plan-row list.** It draws TWO bordered regions,
> each a header row plus three `h-9` bars — the backlog's sprint/backlog grouping, which the plans
> list does not have. It is `app/(authed)/backlog/_components/BacklogContainer.tsx`'s and is used
> only there. Composing it here would stand in for a shape this page never renders, which is the
> same defect measured on `/items/archived` in `design/work-items/design-notes.md` (planning bug
> MOTIR-3521).
>
> **So `/plans` takes no boundary in MOTIR-3445**, and what it would need first is a drawn
> stand-in for a plan-row list — or the generic rung, `PageSkeleton`, which does not exist on
> `main` (MOTIR-3520).
>
> **3. `/plans/[id]`'s two follow-on reads WERE serial and are now one wave**, which the entry
> got right in substance and wrong in detail: it said `assertProjectInWorkspace` _"can start with
> the plan read"_. It cannot — it takes `review.projectId`. What it can do is overlap
> `getEstablishView`, which takes the same value. MOTIR-3445 ships that.

**`components/planning/PlanningWorkspaceSkeleton.tsx` is NOT reused here.** It is `/planning`'s, and
`/planning` already has its boundary from [MOTIR-2069](motir:cmsehmzxf000m04l51c9b71u0); naming it
so a code card does not reach for it by association.

---

# Part X — The plan timeline carrying CONTENT events (MOTIR-3534 / Story MOTIR-3532)

> **The rail's timeline gains a second population of rows and no second treatment.** Everything on
> it today is a status transition; what arrives here is an ACT — an append, a deepen, an edit, by a
> party that is routinely not the party who decided. This Part settles how such a row reads, which
> party it names, how much of the diff it shows, when repeated acts collapse, and what a plan with
> none of them looks like. It draws rows on the section that already renders and nothing else.

**Asset:** `plan-timeline-content-events.mock.html` + `.png` — a NEW asset, per _A design result is
a MOMENT_ above. It does not amend `plans-surface.mock.html` and does not re-export it.

## 0. What ships today, and the gap in one sentence

`PlanHistoryEventDto` (`lib/dto/planReview.ts:206`) is **derived**, not stored: `planReviewService`
computes at most four events from `Plan.createdAt` / `plannedAt` / `decidedAt` / `decisionReason`,
and its only actor field is `byName`, set on the decision events alone. So the surface a person
reads before pressing Approve can say that the plan's STATUS moved and nothing about its CONTENT
moving — and it can name one of the plan's three parties (`createdById` asked,
`authorSource`/`authorHarness`/`authorModel` wrote, `decidedById` decided).

## 1. Drawn against SHIPPED reality — what was RENDERED first

Per the design-against-shipped-reality rule, and Part VIII §1's format. The real
`components/planning/PlanReviewRail.tsx` was bundled with esbuild, wrapped in a real
`NextIntlClientProvider` over the real `messages/en.json`, painted with a real Tailwind v4 build over
`app/globals.css` + `packages/design-system/theme.css`, and screenshotted headlessly at
`deviceScaleFactor: 2`, light theme, in three states — `planned`, `approved`, and a PROBE fed eight
events. The harness was deleted before the design lane ran.

**Five things the render settled, none of them legible in the `.tsx`:**

| #   | Measured                                                                                                                                                                    | What it settles                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | The rail is **352px** wide with **20px** padding, so a row's text column is **298px**                                                                                       | Every label in §3 is chosen to hold that width                                                     |
| 2   | A two-line row is **exactly 36px**; rows are **8px** apart → **44px per row**                                                                                               | The unit the collapse rule in §5 is argued in                                                      |
| 3   | With the four lifecycle events the rail's fixed chrome is **528.5px**, and the rail is ONE scroller (`overflow-y-auto` on the `<aside>`, `mt-auto` on the gate)             | The rail begins to scroll at `height < 528.5 + 44N`. The decision gate is what goes below the fold |
| 4   | The header ALREADY renders an agent as **glyph + harness + model** — and that triple takes **60px / three lines** at this width                                             | §4 borrows the vocabulary and refuses the model on a row                                           |
| 5   | The list ALREADY carries two kinds of row: an event that happened (`--el-accent` dot, two lines) and the one PENDING row (`--el-border-strong` dot, one line, no timestamp) | §2 joins that vocabulary instead of inventing a third dot                                          |

**And one thing the PROBE settled, which is a code fact rather than a drawing one.** `HistoryRow` is
keyed `key={ev.kind}` — unique today only because each lifecycle kind occurs at most once. Feeding
the shipped rail eight events with a repeated kind renders all eight and logs _"Encountered two
children with the same key"_ in a development build. Measured, not inferred. Content rows repeat, so
the key becomes the event's own identity (§8 assigns it).

## 2. Lifecycle vs content — ONE sequence, ONE row grammar, and the WORDING is the discriminator

**Decision: a content event is not a second kind of row.** It joins the same ordered list, in the
same two-line box, with the same dot, and what tells a reader which kind it is, is the row's own
wording — a lifecycle row names a **state the plan reached** (_Plan ready_, _Approved_), a content
row names an **act somebody performed on it** (_6 proposals appended_).

**Why not two treatments.** A second visual language asks the reader to learn a distinction that
pays nothing here: nobody filters this list, nothing acts differently on the two halves, and the
lifecycle rows are themselves acts by parties — the shipped decision row already reads
_Approved · Zhu Yue_. What genuinely differs between the two populations is **volume**, not kind,
and volume is answered by the collapse rule (§5), not by a dot.

**Why the dot is not the place to put it.** The rail's dot already carries a meaning — _it happened_
(`--el-accent`) versus _it has not happened yet_ (`--el-border-strong`, the pending row). A third
tone would overload a two-value signal, and the meaning would then be carried by colour alone, which
the row's own text already carries better.

**What this implies for a plan with MANY content events:** the timeline stops being a four-row spine
and becomes a list whose length is a property of how the plan was written. §5 is what keeps that
readable. **For a plan with NONE:** §6 — it renders exactly as it does today, which is why nothing
about the existing four rows changes here.

## 3. The row grammar — `<label> · <actor>` over a timestamp

The shipped grammar, unchanged: line one is the label plus an optional `· actor`, line two is the
timestamp. Per element:

| Element   | Primitive / token                                                                          | What it says                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| dot       | 6px circle · `--el-accent`, or `--el-border-strong` on the one pending row · `aria-hidden` | Unchanged. The ONLY two-tone signal on the list, and it does not encode lifecycle-vs-content                                 |
| label     | 14px · `--el-text`                                                                         | A past-tense STATE for a lifecycle event; a count + noun + past-tense verb for a content one                                 |
| actor     | 14px · `--el-text-secondary`, after a `·` separator                                        | The party who performed **this act** — not the plan's author column. Omitted entirely when nobody acted on a person's behalf |
| timestamp | 12px · `--el-text-secondary`                                                               | One instant, or a SPAN when the row is a collapsed run (§5). Fixed-UTC formatting, as shipped                                |
| row box   | `flex` · `items-start` · `gap-2`, 8px between rows                                         | 36px tall, 298px text column (§1)                                                                                            |

**The label set, and every member MEASURED at the 298px column:**

| Label                                                | Height     |
| ---------------------------------------------------- | ---------- |
| `6 proposals appended · Claude Code`                 | 36px ✓     |
| `11 proposals appended · Claude Code`                | 36px ✓     |
| `1 proposal edited · Claude Code`                    | 36px ✓     |
| `3 proposals edited · Zhu Yue`                       | 36px ✓     |
| `Closed for review · Claude Code`                    | 36px ✓     |
| `5 proposals appended · Claude Code · claude-opus-5` | **56px** ✗ |
| `Estimate and story points changed · Claude Code`    | **56px** ✗ |

The two that fail are exactly the two things §4 and §5 refuse to put on a row. That is not a
coincidence to note in passing — the measurement is the argument.

## 4. Which party a row names, and how an AGENT actor renders

**A row names the party who performed THAT act.** The timeline moves from naming one of three
parties to naming whichever party acted, per row — which is precisely why a stored trail is needed:
the three `Plan` columns are the three places an actor is currently readable, and none of them
answers _who did this one thing_.

The `source · harness · model` triple renders as **three different things in three different
places**, and the mapping is deliberate:

| Part of the triple | Where it renders                                                                                      | Why                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `source`           | the KIND of actor label: `mcp` → the harness name; `native` → **Motir**; a human → their display name | The header's own two shipped arms (`ReviewAttribution` reads `authorSource` alone since MOTIR-2996), reused rather than re-decided |
| `harness`          | the actor clause on the row — _· Claude Code_                                                         | It is the thing that differs between agent-written plans at a glance                                                               |
| `model`            | **NOT on the row.** It stays on the header's attribution line, and rides the row's `title`            | Measured (§3): the model costs a second line on EVERY row, and the header already carries it once, four rows above                 |

**⚠️ An agent is never styled as a person.** The 18px initial disc is the human's mark and appears
only in the header, where one line names one person; a row carries **no** disc, no avatar, and no
colour of its own for either party. So on this list an unadorned name is a person, and a name that
is a harness is not — no legend, no icon column, no second treatment.

**Nobody is a legitimate actor.** A cadence-originated mutation has no requester (`origin ===
'cadence'`, which the header already reports as _auto-planned, nobody asked_). Such a row renders
with **no actor clause at all** — _1 proposal appended_. It must not be attributed to the project
owner, which is the same reasoning `Plan.createdById` documents for its own null.

## 5. Ordering, collapse, and the DIFF a row shows at rest

**Ordering.** One merged sequence, oldest first — the shipped direction. Stored and derived events
interleave by time; a content event that happened between _Plan ready_ and _Approved_ renders
between them, which is the single most valuable row on the whole list (§7).

**Collapse — on `kind + actor + adjacency`, never on a time window.** Consecutive rows of the same
kind, by the same actor, with nothing between them, are ONE row: the count is over the acts, and the
timestamp becomes a span (_8:24 – 8:26 AM_), in the same 12px slot a single instant uses. No badge,
no count chip, no second line.

- **Why adjacency and not a window.** A window merges two different parties' work whenever they
  happen to fall close together; adjacency cannot, because a different actor breaks the run by
  construction.
- **Why it is not cosmetic.** A titles-first pass is one skeleton append PER LAYER plus one
  `update_plan_item` PER proposal — so ten proposals is eleven rows before a reader reaches anything
  they care about. At 44px a row (§1) that is 484px of timeline; against 528.5px of fixed chrome, it
  is enough on a short window to push **Approve** out of view on a plan nobody has read yet.
- **A collapsed run never swallows a different kind.** _Plan ready_, an approve and a decline always
  break a run, so no decision is ever hidden inside a count.

**The diff at rest: a COUNT, and nothing else.** Not the field names, not the old→new values, not
the proposal titles.

- **Measured:** _Estimate and story points changed · Claude Code_ is 56px. **Two** field names
  already spill to a second line, and a deepen touches up to **nine** fields. A row that names its
  fields is a row that cannot hold them.
- **And nothing expands** — no disclosure triangle, no drawer, no hover card in this revision. What
  a proposal currently SAYS is already two surfaces away and better rendered there: the plan
  detail's LIST view (Part VIII §3) and the proposal READ view (Part V §3). **The timeline's job is
  what MOVED and who moved it**; what it now reads is somebody else's job, and duplicating it here
  buys a worse copy of both.
- **What the row does NOT show, stated so it is not re-litigated:** field names, values, proposal
  titles, the per-proposal breakdown of a multi-proposal append, and the model.

## 6. The LEGACY plan — nothing is drawn, and that is the drawing

**A plan created before this ships renders exactly today's timeline**: its lifecycle events, and
while it is undecided, the pending row. **No** _no changes recorded_ line, **no** dimmed
placeholder, **no** explanatory caption, **no** empty-state illustration.

Two reasons, and the second is the one that generalises. First, every plan in the product today is
this plan, so an empty state here would put a permanent apology on the entire back catalogue.
Second, the absence is not a gap: nothing was recorded because nothing recorded it, and a surface
that draws attention to a truthful absence is inventing a problem for the reader to worry about. The
rail already has a row for the one thing that IS outstanding, and it is the pending row.

**The assertion this earns:** a plan whose revision set is empty produces byte-for-byte today's
event list — a test the read card can write against an empty table.

## 7. Copy — every string this Part introduces (namespace `planReview`)

| Key              | Copy                                                                  | Notes                                                                                                     |
| ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `event_appended` | `{n, plural, one {# proposal appended} other {# proposals appended}}` | The count is over PROPOSALS, not over calls — a collapsed run sums them                                   |
| `event_edited`   | `{n, plural, one {# proposal edited} other {# proposals edited}}`     | Covers the deepen and the post-landing edit alike; the reader's question is the same                      |
| `event_removed`  | `{n, plural, one {# proposal removed} other {# proposals removed}}`   | For the withdraw the sibling story introduces; the label is decided here so the two cards cannot disagree |
| `event_actor`    | `{label} · {actor}`                                                   | The separator, so the row is one translatable unit rather than a concatenation                            |
| `event_span`     | `{from} – {to}`                                                       | The collapsed run's timestamp. An en dash, spaced, matching the rail's existing typography                |
| `writtenByMotir` | _(exists)_                                                            | Reused verbatim for a `native` actor — the header's own string                                            |

Nothing here introduces a new empty-state string, deliberately (§6).

## 8. a11y

- The dot stays `aria-hidden`: it is decorative reinforcement, and the row's own text carries both
  the kind and the actor. **No meaning on this list is conveyed by colour or glyph alone.**
- The agent glyph in the header is unchanged and stays `aria-hidden` — the words _written by …_
  carry it.
- The list stays an `<ol>` in time order, so a screen reader gets the sequence as a sequence.
- **Ink:** every actor clause is `--el-text-secondary` (6.24:1 on `--el-surface`). ⚠️ The shipped
  `HistoryRow` paints `ev.byName` in `--el-text-muted`, which is **4.17:1 on `--el-surface`** and
  below AA — invisible today because only the decision row carries a name, and about to be on most
  rows. §9 assigns the correction to the card that rewrites the row.

## 9. GIVES / TAKES — swept over the story SUBTREE

**TAKES** (premises as well as elements):

- **Part I §3 Panel B's review-rail chrome — a STRUCTURE**: the rail, its header, the History
  section and the decision gate. Composed, not redrawn.
- **Part III §6's DETAIL-header attribution — an ELEMENT and a PREMISE.** The glyph + harness +
  model triple, and its rule that the roles are named in words; §4 compresses it for a row and
  states what is dropped.
- **Part IV's overline status tag and the title's `wrap-anywhere` guard — ELEMENTS, untouched.**
- **Part VII §3's _a decided row names BOTH people_ — a PREMISE**: a plan has parties that differ,
  and naming only one of them is the defect. §4 takes that one level down, to the row.
- **Part V §3 and Part VIII §3 — PREMISES this Part leans on to REFUSE scope**: the proposal read
  view and the list view already render what a proposal says, which is why §5 keeps values off the
  timeline.
- **MOTIR-3189's _the timeline's job is to say what happened_ — a PREMISE**, and the reason the four
  derived events stay derived.

**GIVES:**

- **MOTIR-3536** (the review rail merges stored content events) takes §2 (one sequence, one
  grammar), §3 (the row, per element, and the measured label set), §4 (the party mapping and the
  agent-is-not-a-person rule), §5 (the ordering, the collapse key, the diff-at-rest and its
  exclusions) and §6 (the legacy render). It also takes two corrections named here: the
  **`key={ev.kind}` → per-event identity** change (§1), and the **`--el-text-muted` →
  `--el-text-secondary`** ink fix on the actor clause (§8).
- **MOTIR-3535** (the `PlanRevision` trail) takes §4's _a row names the party who performed that
  act_ as the shape its actor columns must support — the acting user AND the agent triple — and §5's
  _the count is over PROPOSALS_ as what one row's payload must make countable.
- **MOTIR-3537** (the story vitest gate) takes §5's collapse key and §6's legacy assertion as two of
  the properties it holds.
- **MOTIR-3538** (the story E2E + acceptance video) takes §2's _the row arrives in the same
  sequence_ and §4's _an agent renders beside a human and is not styled as one_ as the two beats its
  clip must show.

## 10. Access path

**No new door.** The left nav's **Plans** entry → a plan row → the plan detail at `/plans/{id}`,
where the rail is the right-hand pane and **History** is its second section, under the header and
above the approve gate. This Part adds no route, no tab, no control and no entry affordance — it
adds rows to a section a reader already lands on, so the entrance is stated rather than drawn.

## 11. What Part X does NOT draw

The plan review canvas and its node treatments; the proposal peek / read view; the List ↔ Canvas
switcher and the list body; the approve / decline controls and the decided outcome block; the
staleness summary; the establish band; the `/plans` list surface; and any expansion, filter or
export of the timeline.

---

## Part XI — the FIFTH plan status (MOTIR-3577, 2026-08-26)

**This part SUPERSEDES the four-value lifecycle at the top of this file** (the `Plan.status` line
under _The model_, and Panel A's status-pill list). Both now carry a pointer here.

**The spec it draws is `docs/decisions/agent-authored-plans.md` AMENDMENT 9** (MOTIR-3574), which
settles the name, the transitions and what happens to the incumbent staleness engine. This part
draws what that decided; it invents nothing.

> **The transitions, quoted from AMENDMENT 9:**
>
> | from → to          | trigger                                                       |
> | ------------------ | ------------------------------------------------------------- |
> | `planned → stale`  | a `modify`/`remove` target enters a terminal status           |
> | `stale → planned`  | the drift REVERSES — every fatal target is non-terminal again |
> | `stale → declined` | the reviewer gives up (`decisionReason: 'reviewed'`)          |
>
> **`stale → generating` is deliberately absent** — a proposal cannot be withdrawn or re-targeted,
> so a `stale` plan's exits are _wait for the reversal_ or _decline_. The outcome copy below says so
> rather than offering a repair that does not exist.

### §1 — What was rendered before anything was drawn

`/plans` is a shipped surface, so this part was drawn **against a render of it**, not against the
existing mock. `PlanRow`, `PlanStatusTabs` and `Pill` were bundled from their own source with the
real `packages/design-system/theme.css` and `app/globals.css`, and screenshotted at
`deviceScaleFactor: 2`. **Two things that render settled, which reading the mock would not have:**

1. **The advisory drift pill and the status pill sit on the SAME row**, side by side — the peach
   `severity="warning"` chip (_"3 may be out of date"_) immediately left of the status pill. So the
   fifth status is not choosing a colour against four; it is choosing one against five, one of which
   is already a warning tint. Both were rendered together (the _"Both at once"_ case) before the
   tone was fixed.
2. **`declined` has no tint square at all** — a `--el-muted` grey square with `XCircle`, and
   `Pill tone="archived"`, which renders nearly fill-less. That is the _ended_ treatment, and it is
   what the fifth status must NOT inherit.

### §2 — The row: tone, icon, and the border it does NOT get

| element     | value                                              | why                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| icon square | `bg-(--el-tint-rose)`                              | the one tint no status uses (`sky` / `lavender` / `mint` are taken, `--el-muted` is `declined`'s), and it is the danger-adjacent member of the pastel set                                                                                                                                                                                                                |
| icon        | **`OctagonAlert`** (lucide)                        | a stop sign reads _cannot proceed_. Rendered against `CircleSlash`, `Ban` and `ShieldAlert`: the two slash glyphs read _forbidden_ rather than _stuck_ and are quiet at 16 px, and `ShieldAlert` reads _security_. It is also distinguishable from the advisory `AlertTriangle` at 16 px — octagon vs triangle — which the two slash candidates were not from each other |
| status pill | `<Pill severity="danger">Stale</Pill>`             | the shipped `danger` tone, already in the `Pill` vocabulary — `bg-(--el-tint-rose) text-(--el-text-strong)`, no new recipe. Rendered beside the peach `warning` chip: the two are legibly different, which is the property that matters, because a row can carry both                                                                                                    |
| row border  | `border-(--el-border)` — **NOT the accent border** | `planned` gets `border-(--el-accent)` because it is _awaiting your approval_. A `stale` plan cannot be approved, so the accent would invite a click that fails. It is still in the queue; the rose square and the danger pill are what say _this one needs you_, and they say it without promising the button works                                                      |

**a11y** — the pill carries the word **Stale**; the hue is never the only carrier, and the icon
square stays `aria-hidden` exactly as the other four do (the row's meaning is in its text).

**Contrast** — every `Pill` tone puts its hue in the TINT and its ink in `--el-text-strong`
(charcoal, ~10:1 in both themes — finding #35), and `severity="danger"` is exactly that recipe over
`--el-tint-rose`. So this adds **no ink and no new pairing**. ~~⚠️ The four incumbent status pills in
`plans-tabbed-list.mock.html` carry hue-saturated inks (`#0a4fa0`, `#3a2d8a`, `#0f5e29`) that predate
finding #35 and that the shipped `Pill` no longer paints; the fifth pill is drawn as the component
actually renders it, which is why its ink reads darker-neutral beside them. Do not "match" the
mock's legacy inks in code.~~

> **⚠️ AMENDED 2026-09-03 (MOTIR-4349) — the four legacy inks are GONE from the asset, so there is
> nothing left to mis-match.** `plans-tabbed-list.mock.html` has been re-pointed at the `--el-*`
> layer, and the hand-darkened hues the struck sentence names — `#0a4fa0` (`.pill.generating`),
> `#3a2d8a` (`.pill.planned`), `#0f5e29` (`.pill.approved`) and `#8a3d00` (`.pill.stale`) — are all
> replaced by **`--el-text-strong`** over their existing tint, which is finding #35's recipe and
> exactly what the fifth pill already drew. **The instruction survives its subject:** a build card
> takes the `Pill` component's tone, never a colour read off a mock. What is no longer true is the
> observation it rested on — the fifth pill's ink no longer "reads darker-neutral beside them",
> because all five now carry the same charcoal ink. `plan-canvas-arrival.mock.html` carried the
> identical four inks on its own copy of these pills and is swept in the same change.

### §3 — The WHEN label: no new column for the ROW, one needed for the RAIL

`planRowView`'s `whenFor` picks a timestamp and a verb per status. **`stale` reads `plannedAt` and
keeps the `plannedAt` verb** — _"planned 2 hours ago"_ — because that is still the true and useful
fact in a scanned list: it is the plan's own moment, and the status pill already says what happened
since. **No new column is needed for the list.**

⚠️ **It needs an EXPLICIT `case 'stale'` — falling through is wrong here.** `whenFor`'s `default:`
arm returns `createdAt` (it was written for `generating`), so a fifth enum value that is not spelled
out regresses the row's timestamp silently, with no type error to catch it.

**⚠️ The RAIL is the other answer.** For the rail to say _when_ the plan went stale, the `Plan` model
needs a **`staleAt` timestamp** — nothing existing carries it (`plannedAt` is the close, `decidedAt`
is the decision, and a `stale` plan has not been decided). **MOTIR-3578 is closed against this
sentence:** either it adds `staleAt` and the rail renders it, or the rail's line omits the _when_ and
says so. Recommended: add it — the transitions card is already writing the status, and a timestamp
beside a status is one column.

### §4 — The tab: always shown, at zero

The fifth tab renders **always**, including `Stale 0`, for the reason §4 of Part VII already gives
for `Declined`: _"the tab strip's job is to show you which statuses exist"_, and a tab that appears
only when populated teaches a reader that the vocabulary changes under them. It sits **between
`Planned` and `Approved`** — the strip reads in lifecycle order, and `stale` is a detour off
`planned`, not an ending.

**Empty state:** **"Nothing stale"** — _"A plan goes stale when work it proposes to change has since
been finished. None have."_ (The register Part VII §4 sets: name the state, then say in one sentence
what would put a plan there.)

### §5 — The review rail's outcome line, and the thing four statuses never needed

`declined` reads _"Plan declined — your tree was left untouched"_ — an ENDING. `stale` is not an
ending, so its line must say what happened **and** what the reader can do, and it must not offer the
repair AMENDMENT 9 established does not exist:

> **"Plan out of date — work it changes has since been finished. Approve is unavailable; decline it,
> or wait in case the work reopens."**

**⚠️ AND THE ELEMENT THE STATUS CANNOT CARRY: WHICH PROPOSAL.** The whole complaint behind
MOTIR-3560 is that a reviewer _"can see precisely which proposal went stale and has no way to say
so"_. A pill in a list does not answer that, so the rail places it:

- **In the rail, directly under the outcome line**, a `Pill severity="danger"` per offending
  proposal carrying **the proposal's title and the target's key** — _"Rewrite the settings pane →
  MOTIR-3443 is done"_. One line per fatal proposal, capped at three with a _"+N more"_ tail, since
  the rail is a column.
- **On the item node**, the same `danger` chip on the offending proposal's own card, so the canvas
  and the rail agree without the reader cross-referencing.

Under AMENDMENT 9's UNIFY disposition the engine reports these as a **fatal** `target_terminal`
reason beside its existing advisory ones, so the rail is rendering a list it is already handed — it
is not a second computation.

### §6 — The two "stale"s on one row, said once

After AMENDMENT 9 a row can carry both the advisory count (_"3 may be out of date"_, peach) and the
`Stale` status (rose). They are **the same engine at two severities**, and the row keeps both: the
count is _some proposals drifted_, the pill is _this plan cannot be approved_. Rendered together
before this was fixed; they read as two different facts, which is the requirement. The rail is where
the relationship is spelled out — the fatal reasons appear first, under the outcome line, and the
advisory ones stay in their existing place.

### §7 — What the compiler catches, and the THREE places it does not

Read while drawing this, against the shipped `app/(authed)/plans/`. Adding a fifth `PlanStatusDto`
value splits the code that renders it into two piles, and **only the first pile fails the build**.
MOTIR-3578 is closed against all six lines, not against the two the compiler names.

**The type system FORCES these two** — both are `Record<PlanStatusDto, …>`, so a fifth key is a
compile error until it is filled:

| `PlanRow.tsx` | what to add                    |
| ------------- | ------------------------------ |
| `STATUS_ICON` | `stale: OctagonAlert`          |
| `STATUS_TINT` | `stale: 'bg-(--el-tint-rose)'` |

**⚠️ These four fall through SILENTLY — no type error, wrong output:**

1. **`StatusPill`** ends `return <Pill tone="archived">{label}</Pill>; // declined` — an unguarded
   fallthrough, not a `declined` branch. A fifth status renders as **Declined's chip**: the exact
   _ended_ treatment §2 exists to avoid, and the failure is invisible in a diff. Give `declined` its
   own `if` and make `stale` the explicit `severity="danger"` arm.
2. **`whenFor`** — §3 above: `default:` is `createdAt`.
3. **`staleCountFor`** short-circuits on `plan.status !== 'planned'`, so a **`stale` row would show
   no advisory count at all** — precisely backwards, since it is the row most likely to have one.
   Widen it to `planned | stale`, which is the same widening AMENDMENT 9 D3 already puts on
   `computePlanStaleness`'s own guard.
4. **`awaitingReview`** is `view.status === 'planned'`, and §2 wants it to stay that way — recorded
   here so the widening in (3) is not copied into it by symmetry. The accent border is deliberately
   NOT extended.

**And the copy:** `aiPlanning.status.stale`, the tab label, the tab's empty state (§4), and the
rail's outcome line (§5) are new message keys — **each needs its `zh` twin**, or the catalog parity
gate fails.

---

# Part XII — Asking Motir to REVISE the plan you are reviewing (MOTIR-3597 / Story MOTIR-3595)

**Its OWN asset**: `design/ai-planning/plan-revision.mock.html` + `plan-revision.png`, six panels,
plus this section. It does not amend `plans-surface.mock.html` or any other frozen asset (_A design
result is a MOMENT_).

A reviewer reading a generated plan has three natural reactions and the product serves two of them:
approve it, or decline the whole tree. The third — _it is nearly right_ — has nothing to press. This
Part draws the verb that serves it.

## 0. Drawn against SHIPPED reality — what was RENDERED first

Before a line of the board was drawn, the real `PlanReviewRail`, `PlanProposalList` and
`PlanChangeComposer` were bundled with esbuild against the repository's own sources, wrapped in a
real `NextIntlClientProvider` over `messages/en.json`, painted with the real Tailwind build over
`@motir/design-system/theme.css`, and screenshotted headlessly at the shipped 352px rail width. Four
things that render settled — none of them legible in the `.tsx`, and each of which changed a decision
below:

1. **The rail is 352px wide with 20px padding**, so its content column is **310px**.
2. **The decision block is bottom-anchored** (`mt-auto`), so a `planned` plan already shows a large
   empty band between the history and Approve. The new composer costs that band, not a scroll.
3. **The hint under the buttons already carries the reason a control is unavailable** — _Review
   unlocks when generation completes_, swapped in for a `generating` plan. §3 reuses that grammar
   rather than inventing a second one.
4. **The shipped composer renders an `@` trigger inside its input.** §2 takes it away, and that is a
   prop rather than a style.

## 1. §A · Placement — INSIDE the decision block, above the two verbs, behind the rail's own rule

**The access path is the affordance itself.** `/plans/<id>` is reached exactly as Part I §5 draws it;
this story adds no route and no entrance. The door it adds is the composer, and it is drawn in place:
a one-line field inside the bottom-anchored decision block, **above Approve and Decline, separated
from them by a 1px `--el-border` rule**.

**Why it is not a third button.** Approve and Decline are terminal — each ends the review — and a
third control in that stack reads as a third way to end it, which is exactly what this verb is not. A
text field is a different kind of thing: it asks for an instruction rather than a decision, and a
reader who has just read two buttons does not mistake an input for a third. The relationship the card
asks to be VISIBLE is therefore carried by the rule and by the FORM, not by a label explaining it.

**Rejected — a button that opens the composer.** It draws a door to a door: one more click, one more
state to specify, and a reader still has to guess what is behind it. The field IS the door and says
what it takes.

**Rejected — the composer at the very foot, BELOW the buttons.** It would put the least terminal
control furthest down, and separate it from the two verbs the card asks it to sit next to.

## 2. §B · It composes `PlanChangeComposer`, with the `@` trigger SUPPRESSED

This is a real change, not a styling choice. The trigger opens `useWorkItemTargetSearch`, which
searches the project's **committed work items**. A revision is anchored at the PLAN and the things it
can name are **proposals**, which have no key to mention until somebody approves them. Offering the
picker here searches the wrong universe and returns rows the instruction cannot act on.

So the shipped composer gains **one prop** — `mentions={false}` — hiding the trigger and the tray,
and the plan-revision case does not fork a second input. The alternative (a bespoke field beside the
shipped one) buys nothing and splits the placeholder / accessible-name contract, the disabled
handling and the Send button across two components.

## 3. §C · IN FLIGHT — Approve is HELD, and the reason is real text

**This section draws what MOTIR-3596 decided and decides nothing itself.**
`docs/decisions/agent-authored-plans.md` **AMENDMENT 10 D2** closes the approve / revise race with a
LEASE on the plan: while a revision holds it, `approvePlan` and `declinePlan` are REFUSED, the tree is
untouched, and neither act cancels the other — the loser retries.

The rail says that with the grammar it already has:

- **Approve and Decline take the shipped disabled treatment**, and the hint beneath them is REPLACED
  with `approveHintRevising` — the same swap `discardHint` already performs for a `generating` plan.
  This is the card's own criterion that a reviewer is never offered a verb that will be refused,
  applied to a second CONDITION rather than through a second mechanism.
- **A band above the composer names what is running, and echoes the instruction.** `--el-tint-sky`
  under `--el-text-strong` — the one tint no plan STATUS spends (Part XI took rose for `stale`,
  Part I lavender / mint / sky-for-`generating`… and the band is not a status, so it must not be read
  as one). It is **not** an alert: nothing failed, the planner is simply working. Same reading the
  shipped answer bar makes in `PlanChangeComposer`.
- **The optimistic hold is not the whole answer, deliberately.** A lease can be taken between the
  render and the click, so the disabled state is a courtesy and not a guarantee. The refusal that
  arrives anyway lands in the rail's SHIPPED `role="alert"` line above the gate — one sentence, in
  place, plan still readable. Two mechanisms, because the client cannot know the answer and the
  server can.

## 4. §D · LANDED — the timeline says what happened; the count says how much

Two new rows, in Part X's sequence and grammar — one label, one actor clause, one timestamp, no badge
and no second treatment:

| kind               | label            | why this wording                                                                   |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------- |
| `revision_started` | Revision started | the same tense as `Generation started`, which it is the sibling of                 |
| `revision_ended`   | Revision landed  | names what ARRIVED. _finished_ would be about the job; the reviewer wants the plan |

**The pair BRACKETS the revision, and that is also what makes it the lease** (MOTIR-3596): a
`revision_started` with no `revision_ended` after it, inside the window, is a held plan. So the
reviewer learns a revision is running by reading the timeline they were already reading, and the
product needed no second place to record it.

**The MODEL is not in the clause**, for the reason Part X measured: at the rail's 298px text column a
model name costs every row a second line, and the header carries it once already. It rides the row's
`title`.

**A WITHDRAWAL is legible here and nowhere else.** A proposal taken off the plan leaves no row in the
list to mark, so the account is the header's item count moving (11 → 10) beside a timeline row saying
one proposal was withdrawn. **No third surface is added to carry it**, and the Approve CTA — which
names the count it will create — restates it a second time for free.

## 5. §E · WHAT CHANGED — the LIST, not the canvas

**The canvas already has an emphasis mode and it means something else.** Part IX's _Show changes_
rings every PROPOSAL on the level and dims the committed cards around it: it answers _which of these
is proposed?_ A reviewer returning from a revision asks a different question — _which of these moved
since I looked?_ — and a second ring on the same canvas to mean a second thing gives one surface two
highlight languages. Part IX §L3 chose the ring precisely because there was one vocabulary; adding a
rival is the thing that rule exists to prevent.

**So the recency fact goes in the LIST**, which groups by op and already carries a per-row chip
cluster. The marker is the shipped `Pill` in the shipped slot:

- **`Pill severity="info"`, reading _Revised_**, in the row's right cluster, **in front of the op
  chip** — the same slot the shipped _Stale_ pill uses, which is also a "something happened to this
  row" marker. The hue lives in the tint background under `--el-text-strong`, the recipe every other
  chip on the row uses.
- **The op chip does not change.** Op says WHICH kind of change this proposal is; the pill says THAT
  this one moved. Orthogonal, exactly as Part IX §L2 holds for the emphasis — a build card must not
  read either as an alternative to the other.
- **No row fill, no ring, no border.** The board tints two rows only so they are separable on a
  static export; that tint is the shipped hover fill and **is not part of the specification.** A
  persistent fill would be colour carrying meaning, which the chip already carries in a word.

**Show changes is untouched**, on the canvas, meaning what it has always meant.

## 6. §F · Copy, tokens, a11y, page state

The full string table and the per-element token table are **panel 6 of the asset**. The three things
worth repeating outside it:

- **Every new key needs its `zh` twin** or the catalog parity gate fails. Nine keys, namespace
  `planReview`.
- **`--el-text-secondary` for every caption on the board and every note in the surface** (6.24:1 on
  `--el-surface`); `--el-text-muted` is 4.17:1 there and would fail, and `--el-text-faint` clears AA
  on no surface at all.
- **Page state after the revision lands is the hard part of the build card, and it is enumerated
  there rather than here.** The revision arrives from a JOB while the reviewer sits on the page, and
  `/plans/[id]` is a Server Component: `router.refresh()` re-runs `planReviewService.getPlanReview`
  and IS what updates the canvas, the list, the item count, the timeline and the Approve state. What
  it **cannot** reach is any client island seeded by a `useState(initialProps)` initializer — the
  List/Canvas switcher, an expanded proposal — which needs a tick it watches. MOTIR-3601 names which
  mechanism carries which surface in its pull-request body.

## 7. §G · What this Part assigns to its sibling cards

| what                                                                                         | card                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| the lease, the refusal, and what a held Approve means                                        | **MOTIR-3596** — the decision (AMENDMENT 10 D2), already made |
| the composer, the `mentions={false}` prop, the in-flight band, the held gate, the page state | **MOTIR-3601** — the revision affordance                      |
| the two `changeKind` verbs reaching the timeline read path                                   | **MOTIR-3599** / **MOTIR-3601**                               |
| the _Revised_ pill's data — which proposals the latest revision touched                      | **MOTIR-3601**, off the plan's own trail; no new column       |

## 8. §H · Explicitly OUT of scope (so nobody builds it twice)

- **No second planning workspace.** The affordance composes the rail; `/plans/<id>` keeps its shape.
- **No new `PlanStatus`, no status chip for one.** The plan is `planned` before, during and after a
  revision (the story's boundary, and AMENDMENT 10's).
- **No redraw** of the canvas, the proposal peek, the approve / decline controls, the staleness
  summary, the decided outcome, the plans list or Part IX's _Show changes_.
- **No proposal-edit modal.** MOTIR-3084 removed it and Part V §3 recorded why; a revision is asked
  for in words, which is the whole point.
- **No diff view of a proposal's before / after.** The reviewer sees the plan as it now stands, marked
  where it moved. A per-proposal diff is a real surface and a different card; nothing here depends on
  it.

## ⚠️ AMENDED 2026-09-24 by MOTIR-6236 — the revise box is a MULTI-LINE field

**The drawing lives in `design/ai-chat/planning-workspace--multiline-composer.mock.html`, sheet 11,
and this is a POINTER to it rather than a second drawing.** Part XII's own panels stay exactly as
drawn.

`PlanChangeComposer` is one component with two hosts, and the revise box is the second. When it
becomes a multi-line auto-growing field on the planning rail it becomes one here too, with the same
cap (**8 rows / 184px**), the same bottom-aligned Send and the same `resize-none`. Two things are
specific to this host and are drawn on that sheet:

- **`mentions={false}` still holds** (§B's reason is unchanged — a revision names PROPOSALS, which
  have no key to mention), so there is no `@` trigger and the field carries no left inset.
- **The pinned decision footer does not move.** The box grows into the scrolling body above it, never
  into the footer — which is what keeps §A's _composer inside the decision block, above the two
  verbs_ true at every height.

`reviseNote` is unchanged: shown only while the field has text.

**⚠️ AND THE WIDTH: the revise box is NOT a split host.** MOTIR-6249's resizable split (story
MOTIR-6248) makes the planning surface's conversation pane a draggable third of its container, and
MOTIR-6236's sheets were redrawn at that width. **This host is unaffected**: the plan page's rail keeps
its own width, so no number in Part XII moves. Measured, its container-derived 378px default puts the
field at 328px, where the composer behaves exactly as at the planning surface's 480px default — same
cap, same row arithmetic, same alignment. The one width at which the same message costs an extra row
is the split's 352px floor, which this host never takes.

---

# Part XIII — The plan DETAIL, refined: the proposed title, the fold, the changes lit on arrival, the locate walk, the search box's own words, the derived default, a clickable row, and the rail's decision (MOTIR-4017 / Story MOTIR-4016)

**Its OWN asset**: `design/ai-planning/plan-detail-refined.mock.html` + `plan-detail-refined.png`, plus this
section. Parts VIII, IX and XII stay exactly as drawn; where this Part changes something one of them
decided, it says so HERE and does not re-export their assets (_A design result is a MOMENT_, above).

**Eight refinements to `/plans/[id]`, drawn as ONE board because they all move the same chrome**: the
review model's title, the pane's height, the canvas's top-right cluster, its bottom-left cluster, the
list body's rows, the read modal's corner, and the rail's decision. Each is small; taken separately by
eight cards they would be eight different answers to the same four files.

## 0. Drawn against SHIPPED reality — what was RENDERED first, and what the render settled

**Every number in this Part is measured in Chromium against the running app at `origin/main` @
`f9b9443e7`**, on a seeded tenant (`tests/e2e/_helpers/plans-shapes-seed.ts` shape TWO — a plan with two
`add`s and one `modify` carrying `patch.title`, under one committed epic), at 1440×900, 1366×768,
1280×800 and 1920×1080, with the Plan-with-AI orb mounted (`--shell-bottom-clearance: 6rem`). The
harness is reproduced inline in §14 rather than cited, because it is deleted before this asset lands.

**Four things the render settled that reading the source could not, and two of them contradict this
card's own premises:**

| what was rendered                                             | what it settled                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the pane at four viewports                                    | the chrome above the canvas box is **133 px**, not the 136 px the box subtracts — and the box subtracts `--shell-bottom-clearance` a SECOND time on top of that. **The page does NOT scroll at any of the four** (§2)   |
| the Show-changes toggle with `aria-pressed="true"`            | `backgroundColor: rgba(0, 0, 0, 0)`. The pressed control has **no fill at all** — the token it names does not exist (§3e)                                                                                               |
| six crowded levels × four viewports (24 arrival scales)       | the arrival scale on THIS canvas is capped at **0.686** at 1440×900 by the canvas's WIDTH before the level's height is considered, so `ARRIVAL_MIN_SCALE = 0.80` **is not reachable here at all** (§6)                  |
| the rail with a long generated title and a nine-turn timeline | Approve's bottom sits at **1037 px** in the rail's scroll space against a visible bottom of 676 (1366×768) / 800 (1440×900) / **980 (1920×1080)** — the decision is below the fold **even on a 1920×1080 display** (§8) |

**⚠️ TWO CARD PREMISES ARE FALSIFIED BY THE MEASUREMENT, and both are amended on the record rather than
quietly built around** (`run.md` — _a falsified premise is REPORTED, never silently re-scoped_):

1. **"at 1366×768 … the page SCROLLS."** It does not. `document.documentElement.scrollHeight ===
innerHeight` at all four viewports. What the shipped shape actually does at 1366×768 is bind its
   `min-h-[34rem]` floor (544) above its own computed height (536) and eat **8 px of the shell's own
   clearance band**, leaving a **91 px dead band** under the graph. The defect is real, its size is
   what was measured, and its NAME was wrong.
2. **"how many nodes can a level hold and still arrive at or above the floor?"** — that number does not
   exist for this surface. §6 measures why and states the predicate the measurement DOES support.

Planning bug filed under `MOTIR-1465`; this card's §6 and §2 criteria are amended with the evidence.

## 1. §1 · The PROPOSED title — the node shows what the plan is ASKING for

### The defect, read and rendered on `origin/main` @ `f9b9443e7`

`planReviewService.getPlanReview` builds every item's `title` as

```ts
title: item.op === 'add' ? (proposed?.title ?? 'Untitled item') : (target?.title ?? 'Unavailable item'),
```

so a `modify` carrying `patch.title` reports the title of the card it is about to RENAME. Three lines
earlier the same function's `buildChanges` files that rename as a `title` change row with `from` and
`to`. **The surface therefore names the card by what it is called, and separately and much more
quietly by what it will be called.** Rendered: the canvas node's headline reads `Invoice templates`
while a ~10 px inline overlay under it reads `Title Invoice te… → Invoice template s…`, both ends
truncated past reading.

### The decision

**The review model reports the title the plan PROPOSES.** `title` becomes
`patch.title ?? target.title` for a `modify`, and is unchanged for `add` (the proposed title, which is
the only one there is) and for `remove` (the target's, which is the only one there is).

| surface                | shows                                                                        | why                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the canvas NODE        | the **proposed title ALONE**                                                 | the node is a SIGNAL (Part VIII §3). It is `NODE_W`×`NODE_H` = 280×124 with a fixed height, so a second title line has nowhere to go, and the `change` badge already says THAT it changes |
| the node's inline diff | **unchanged** — it keeps spelling `old → new`                                | it is the node's own overlay and this Part does not redraw the node treatments (Part I §3 panel B). What changes is which end of it the HEADLINE agrees with                              |
| the LIST row headline  | the **proposed title**, and its `TITLE` change line still spells `old → new` | Part VIII §3 already split these: the list is where a change is SPELLED. Neither becomes redundant — the headline says what the card will BE, the change line says what it is leaving     |
| the list row's key     | **unchanged** — the committed `identifier`                                   | the pair is what makes a rename legible: a real key beside the name it is about to take                                                                                                   |

**The constraint Part VIII settled and this must not re-litigate: the node is a SIGNAL and the list is
where a change is SPELLED.** This Part changes only which title the signal carries; it adds no second
place a change is spelled and takes none away.

**Rejected:** the node showing `old → new` in its headline (two names in a 280 px box, and the reviewer
is deciding about one of them); and dropping the list's `TITLE` change line as redundant (it is the only
place the outgoing name survives, and a rename is exactly the change a reviewer wants to read in full).

**⚠️ ONE DELIBERATE DEVIATION FROM THE SHIPPED MARKUP, and it is a defect the guard found.** The
node's inline diff overlay (`data-testid="diff-line"`) paints its field label and its struck old value
in `--el-text-muted`, on a card whose fill is `--el-surface`. `tests/design-ink-contrast.test.ts` fails
that pair — **4.12–4.34:1, below AA, at `text-xs`** — and it is right: the asset draws the overlay in
`--el-text-secondary` (6.18–6.80:1 on all four surfaces, both themes) rather than reproducing an
inaccessible pair. **This is a SHIPPED defect, not one this story introduces**, it survives every card
in MOTIR-4016 (§1 leaves the overlay otherwise untouched), and it is filed as its own bug rather than
left as this paragraph.

**⚠️ The quick view is a THIRD surface and it is NOT this Part's.** A `modify` node's **View** opens
`WorkItemQuickView` — the committed work item, which correctly shows the committed title, because that
modal reads the work item and not the proposal. Naming it so nobody widens §1 into it.

## 2. §2 · The pane FILLS THE FOLD — the chrome budget, MEASURED

### The budget

The chrome above `app/(authed)/plans/[id]/page.tsx`'s canvas box, measured (not summed) in Chromium at
all four viewports — the numbers are identical at every one:

| term                                                                                                      | px                            |
| --------------------------------------------------------------------------------------------------------- | ----------------------------- |
| the top nav — `h-14` plus its 1 px bottom hairline                                                        | 57                            |
| the shell's `pt-6` (`app/(authed)/layout.tsx`)                                                            | 24                            |
| this page's `<header>` — a `size-(--height-control)` back-link beside a `text-xl` h1 whose line box is 28 | **36** (= `--height-control`) |
| the page stack's `gap-4`                                                                                  | 16                            |
| **total**                                                                                                 | **133**                       |

**⚠️ ONE OF THOSE FOUR TERMS IS NOT A CONSTANT, and that is why this spec reads a token instead of
baking a number.** The header's height is `--height-control`, which every `[data-style]` axis
redefines: **34 px** (`swiss-minimal-flat`, `cybercore-y2k`) · **36** (default, `neo-brutalism`) ·
**38** (`glassmorphism`, `aurora`, `hand-drawn-indie`, `neumorphism`) · **40** (`soft-playful`,
`3d-immersive`). A flat `8.3125rem` would be wrong by up to 4 px on seven of the nine styles. The
roadmap's own 10 rem is safe from this because its header is an `h1` + subtitle stack, which no style
axis moves; **this page's is not, and the difference is worth a sentence because the two look like the
same fix.**

### What ships today, MEASURED

The box is `h-[calc(100dvh_-_8.5rem_-_var(--shell-bottom-clearance,1.5rem))] min-h-[34rem]`. With the
orb mounted that subtracts **136 + 96 = 232 px** for a chrome that costs **133**.

| viewport (window) | chrome | box today | box bottom | dead band below | `min-h` binds?      | page scrolls |
| ----------------- | ------ | --------- | ---------- | --------------- | ------------------- | ------------ |
| 1440×900          | 133    | 668       | 801        | **99**          | no (668 > 544)      | **no**       |
| 1366×768          | 133    | **544**   | 677        | **91**          | **YES** — 536 → 544 | **no**       |
| 1280×800          | 133    | 568       | 701        | **99**          | no                  | **no**       |
| 1920×1080         | 133    | 848       | 981        | **99**          | no                  | **no**       |

**At 1366×768 the floor exceeds the box's own `calc`**, so the pane is 8 px taller than the height it
computes and spends 8 px of the shell's clearance band. **It does not make the page scroll** — the
shell's `pb-(--shell-bottom-clearance)` absorbs it — which is the card's claim corrected in §0.

### THE SPEC — the pane TAKES the band, and READS the term that moves

```css
/* the chrome above, each term named: nav + hairline, the shell's pt-6, this page's gap-4,
   and the header — which is one control tall and therefore style-dependent */
height: calc(100dvh - (3.5rem + 1px) - 1.5rem - 1rem - var(--height-control));
margin-bottom: calc(-1 * var(--shell-bottom-clearance, 1.5rem));
min-height: 34rem; /* kept, and it stops binding at every viewport measured */
```

| viewport  | box today | box proposed | gain    | dead band after |
| --------- | --------- | ------------ | ------- | --------------- |
| 1440×900  | 668       | **767**      | **+99** | 0               |
| 1366×768  | 544       | **635**      | **+91** | 0               |
| 1280×800  | 568       | **667**      | **+99** | 0               |
| 1920×1080 | 848       | **947**      | **+99** | 0               |

The canvas VIEWPORT the arrival scale is computed against is the box minus its 1 px border, the 44 px
pane header (`h-11`, Part VIII §2) and one more border, and minus the rail's `22rem` in width:

| viewport  | canvas viewport today | canvas viewport proposed |
| --------- | --------------------- | ------------------------ |
| 1440×900  | 782×622               | **782×721**              |
| 1366×768  | 708×498               | **708×589**              |
| 1280×800  | 622×522               | **622×621**              |
| 1920×1080 | 1262×802              | **1262×901**             |

### The ORB — and the answer here is NOT the roadmap's

The roadmap declares `--canvas-fold-inset` on the box that spends the band, so
`ProjectRoadmapCanvas`'s bottom-RIGHT control lifts clear of the orb. **This pane must not do that, and
the reason is the two-column grid.** `PlanningWorkspace` is `grid-cols-[1fr_22rem]`, so the box's
bottom-right 352 px belong to the **RAIL**, not to the canvas. Measured at 1440×900: the orb is
`fixed right-5 bottom-5`, 56 px square, at **x 1364–1420, y 824–880**; the rail spans **x 1055–1407**;
the canvas column ends at **x 1055**. The orb is over the rail and **309 px clear of the canvas**.

- **The canvas gets NO inset.** This pane does NOT declare `--canvas-fold-inset`, so
  `ProjectRoadmapCanvas`'s Reset-layout control stays exactly where it is — and the other three
  consumers, which inherit nothing, are untouched. A code card that copies the roadmap's line here
  lifts a control that has nothing to clear.
- **The RAIL gets the inset, and it is §8's pinned footer that carries it** — see §8. The rail is not a
  shared component, so it reads the shell's own `--shell-bottom-clearance` directly rather than through
  the canvas's indirection. Measured: with the band spent, the rail's bottom is the window's bottom, and
  the orb covers its bottom **76 px**; a footer reserving `var(--shell-bottom-clearance)` puts the lowest
  control's bottom at **798** against the orb's top of **824** — 26 px clear.

## 3. §3 · The changes are LIT ON ARRIVAL

`ProjectRoadmapCanvas.tsx:386` holds `showChanges` at `useState(false)`, on a surface whose entire
subject is what the plan changes. **The emphasis arrives ARMED.**

### (a) It re-arms on every LEVEL CHANGE, including a drill

The state already resets on every level change, alongside `selectedId` / `highlightId` — deliberately,
so a stale emphasis never survives a drill. **This changes the reset's TARGET from `false` to `true`;
it does not add a reset.** So a reader who turns the emphasis off and then drills arrives armed again.

**Why that, and not "remember off":** the reset is per LEVEL and a drill is a new question about a new
set of cards. A mode remembered across drills makes the page's own subject invisible on every level
after one click, and the reader has no way to know that is why. This is the exact shape Part IX §L4
settled one tier down — _a selection is a momentary act; the toggle is a mode, and a mode should
survive one_ — read here at the level boundary rather than the selection boundary.

### (b) The armed state announces itself with its own treatment, and adds NO extra affordance

The control keeps the pressed treatment (§3e) and its label stays the VERB — _Show changes_. A pressed
button carrying an action is read as _this is on; press to turn it off_, and `aria-pressed` says the
same thing to a screen reader without anything being drawn. **No tooltip, no first-run hint, no dismiss
×.** Any of those would be chrome that exists only on a first arrival, and nothing on this surface could
then decide when it should stop appearing.

### (c) A DECIDED plan arrives armed too

Part IX §L7 kept the control after the decision, in the past tense (_Show what changed_). It arrives
armed for the same reason it survives: _"what did this plan change?"_ is a better question after approve
than before it, and the decided pane exists to be a RECORD (Part VI). One rule, two labels.

### (d) ⚠️ A level that is ENTIRELY the plan's — DISABLED. **This REVERSES Part IX §L6's second bullet**

Part IX §L6 decided: a level with NO proposals disables the control (_"an ON state would dim every card
and ring none — a screen that says nothing"_), and a level that is entirely the plan's stays **enabled**,
where _"ON simply rings everything with nothing to dim. Correct and harmless."_

**Harmless is a property of a state the reader CHOSE.** Arming it automatically makes the same state
arrive unasked — a screen where every card is ringed and none is dimmed — and a ring that is on
everything teaches the reader, at the moment they arrive, that the ring means nothing. That is the
identical argument §L6 used for the empty case, and it applies to its mirror the moment the control is
armed rather than pressed.

**So the two degenerate levels take the SAME disposition and DIFFERENT reasons:**

| level                      | control      | reason (its `title` + accessible description)                                      |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| no proposals on this level | **disabled** | `roadmap.canvas.showChangesNone` — _No proposed changes on this level_ (unchanged) |
| every card is the plan's   | **disabled** | **new** — `planReview.showChangesAll` — _Every item on this level is this plan's_  |

The level CAPTION already says the second one (`planReview.allProposedLevel`, Part IX §1.4), so the
control and the caption agree instead of one of them contradicting the screen. **The reason string is the
CONSUMER's**, exactly as `emptyLabel` is: the foundation does not know it is showing a plan.

**This is recorded here and Part IX's asset is not re-exported** — the correction belongs in the notes
precisely because the asset it corrects is frozen (the area rule at the top of this file).

### (e) ⚠️ THE ACTIVE FILL — `--el-accent-soft` DOES NOT EXIST, and here is exactly how it got there

**Measured**: with `aria-pressed="true"`, `getComputedStyle(toggle).backgroundColor` is
**`rgba(0, 0, 0, 0)`**. The pressed control has no background. Its border and ink are correct
(`rgb(86, 69, 212)` — `--el-accent`), so it renders as an outlined ghost beside a search input that has
a solid fill, and nothing anywhere is red.

**The chain, and it is worth writing down because the mechanism will produce the next one:**

1. `plan-canvas-arrival.mock.html:36` declares a LOCAL `--accent-soft: #f4f2fd` — a hex that appears
   **nowhere** in `packages/design-system/theme.css` or `app/globals.css` (`git grep f4f2fd` → 0).
2. Part IX §L1 (`design-notes.md:1853`) wrote that up as _"ACTIVE takes `--el-accent-soft` fill"_ — a
   local mock variable transcribed into the `--el-*` namespace, where it reads exactly like a token.
3. `ProjectRoadmapCanvas.tsx:1087` built it faithfully: `bg-(--el-accent-soft)`.
4. `git grep -- '--el-accent-soft *:'` returns **zero definitions**, in either theme, on any style axis.

Tailwind emits `background-color: var(--el-accent-soft)`, an unresolved custom property is invalid at
computed-value time, and the declaration is simply dropped. No build error, no lint, no test. **A mock
that declares its own token names lets a name that exists only in the mock reach production as though it
were a design-system token** — which is why this asset declares none (§14).

> **⚠️ AMENDED 2026-09-03 (MOTIR-4349) — step 1's declaration is DELETED, and the chain can no
> longer start there.** `plan-canvas-arrival.mock.html` now declares the `--el-*` element-token
> layer and nothing else, so `--accent-soft: #f4f2fd` is gone (with the whole private-alias block it
> sat in) and the `:36` line reference no longer resolves. The wash is
> **`--el-accent-wash: color-mix(in srgb, var(--el-accent) 6%, var(--el-page-bg))`** — a name that
> is still local to the asset, but whose VALUE is derived from tokens rather than invented, so
> transcribing it into a build card yields `color-mix()` over two real tokens instead of a hex that
> resolves nowhere. **Steps 2–4 and the decision below are unchanged and still correct.** The class
> fix is `plans-tabbed-list.mock.html` and this asset carrying no privately-named colour at all
> (MOTIR-4318's population), and the guard that will assert it tree-wide is MOTIR-4353.

**THE DECISION — the ACTIVE fill is `--el-tint-lavender`, and it is defined everywhere:**

| slot   | token                    | verified                                                                         |
| ------ | ------------------------ | -------------------------------------------------------------------------------- |
| fill   | `--el-tint-lavender`     | `theme.css` — light `#e6e0f5`, dark `#2a253a`, redefined by every `data-palette` |
| border | `--el-accent`            | `theme.css:2425` (`var(--color-primary-fill)`) — unchanged from Part IX          |
| ink    | `--el-accent-on-surface` | `theme.css:2427` / `:2953` — unchanged from Part IX                              |

**Why this pair and not another, in three lines that are all checkable:**

- **It is the shipped ACTIVE-CONTROL pairing.** `components/ui/Sidebar.tsx:151` gives the active
  navigation destination `bg-(--el-tint-lavender) text-(--el-accent-on-surface)`. This is that treatment,
  on a control that is active for the same reason.
- **Its contrast is ASSERTED, not hoped for.** `theme.css`'s own comment above `--el-accent-on-surface`
  says the 82 % mix was sized against exactly this pair: _"The binding constraint is
  `--el-tint-lavender` — the accent family's own tint … 82 % … 4.68:1"_, and `inkContrastLint`'s accent
  arm recomputes it over every palette × theme. **This Part introduces no new pair to measure.**
- **It is SOLID**, which is what the card asked for: the neighbouring full-screen and locate controls
  carry an opaque `--el-surface` fill, and `--el-tint-lavender` is an opaque fill too. The pressed state
  stops being the only control in the cluster you can see the canvas through.

**The one collision, named rather than left to be found:** `PlanItemNode.tsx:96` gives a PROPOSED node
`border-dashed border-(--el-accent) bg-(--el-tint-lavender)`. The toggle is chrome in the canvas's
top-right cluster, not a card on the board; it is 36 px tall, carries an `Eye` glyph and a text label,
and has a SOLID accent border where the node's is dashed. **Reading the two as the same object requires
ignoring the position, the size, the glyph, the label and the border style.** Recorded because Part VI
§3 established that a non-collision on this surface is stated explicitly rather than assumed.

**AND Part IX §L1's sentence is CORRECTED in the same pull request** (§13) — a Part that names a second
undefined token repeats the defect this section exists to close.

## 4. §4 · The LOCATE walk

`PlanReviewCanvas` passes no `locatable` at all, and `locateActionable` (`ProjectRoadmapCanvas.tsx:877`)
targets `here` / `ready` nodes, which a proposal never is. The control is doubly out of reach.

### The decision — the locate control walks the EMPHASIS set

**When `emphasis` is supplied, the locate targets are `emphasis.ids` restricted to the level in view;
otherwise the `here` → `ready` ladder is unchanged.** One prop, not two: the emphasis and the locate
control are the same set of nodes seen twice — ringed, and walked — and a second `locate` set would be a
second answer to _which cards are the plan's_ that could drift from the first. `WorkItemRoadmap` and the
Children panel are byte-unchanged, because neither passes `emphasis`.

| question                          | answer                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the ORDER**                     | **LAYOUT order** — the order `deterministicLayout` places them in, left-to-right then down. Not `op` order (which jumps around the board between three groups) and not the plan's append order (which is invisible on screen). The reader is walking a picture; the walk moves the way the eye does   |
| **the `n / m` hint**              | unchanged in form — `${i + 1} / ${m}`, shown only after the first press and only while `m > 1`. **`m` is the plan's cards ON THIS LEVEL**, never the plan's total                                                                                                                                     |
| **why `m` is not the plan total** | the walk cannot reach an off-level card, and a hint that counts past where the control can go is a promise it does not keep. **The off-level total is already said, once, by the Show-changes control's `3 of 11`** (Part IX §L5) — two counts, two scopes, and neither is the other's rounding error |
| **wrapping**                      | unchanged — past the last it returns to the first, as the ready-node cycle does today                                                                                                                                                                                                                 |
| **selection**                     | unchanged — locate centres AND selects, at `LOCATE_ZOOM`, so the located card's View / Open surface                                                                                                                                                                                                   |
| **DISABLED, and when**            | a level the plan does not reach — the same condition that disables Show changes, carrying **the same string** (`roadmap.canvas.showChangesNone`). One reason, said once; §L6 already decided the wording and this does not invent a second                                                            |

**⚠️ On an ALL-PROPOSALS level locate is ENABLED where Show changes is DISABLED (§3d), and the
difference is not an inconsistency.** Ringing every card says nothing, because a ring means _this one and
not that one_. Walking every card says something, because a walk means _this one, now this one_. The two
controls fail on opposite degeneracies, and drawing them as one rule would break the useful half.

## 5. §5 · The search box says what it SEARCHES

The input's `aria-label` and `placeholder` are both `t('search')` on the `roadmap.canvas` namespace,
whose English is **"Search the roadmap"** (`messages/en.json:5707`). **Rendered on `/plans/[id]`: the
box on a plan-review page offers to search the roadmap.**

### The decision — `searchLabel` is the CONSUMER's word, and turning search on REQUIRES saying it

`ProjectRoadmapCanvas` gains `searchLabel`, used for both the `aria-label` and the `placeholder` exactly
as `t('search')` is today. **It is not optional with a roadmap-shaped default**, because a default is
how the wrong sentence got onto four surfaces from one: the prop is required whenever `searchable` is
set, expressed in the component's own props type so a consumer cannot turn search on without saying what
it searches. **This is the ONE change in this story that sweeps all four consumers** — the story's
boundary names it as the exception, and this is why.

| mount                                                           | searchable?                   | label + placeholder | en                      | zh         | namespace                          |
| --------------------------------------------------------------- | ----------------------------- | ------------------- | ----------------------- | ---------- | ---------------------------------- |
| `PlanReviewCanvas` — `/plans/[id]`                              | yes                           | changes             | **Search this plan**    | 搜索本计划 | `planReview.searchLabel`           |
| `PlanChangeCanvas` — the re-plan conversation                   | yes                           | changes             | **Search this project** | 搜索本项目 | `planningWorkspace.searchLabel` ⚠️ |
| `OnboardingCanvas` — `searchable={!!projectKey}`                | yes, when pinned              | changes             | **Search this project** | 搜索本项目 | `onboarding.searchLabel`           |
| `WorkItemRoadmap` — `/roadmap` (`RoadmapView`)                  | yes                           | **UNCHANGED**       | Search the roadmap      | 搜索路线图 | `roadmap.canvas.search`            |
| `WorkItemRoadmap` — the item page Children panel (`ChildPanel`) | **no** — `searchable={false}` | **none is owed**    | —                       | —          | —                                  |

**Why the plan review says _plan_ and the plan-change canvas says _project_.** The review canvas draws
ONE plan's proposals on the levels they land in, and the page is a plan; the change canvas draws the
PROJECT with a pending proposal layered onto it (`PlanChangeCanvas`'s own header comment), and a reader
searching there is searching the tree. Onboarding is the same tree, being built.

**`roadmap.canvas.search` stays exactly where it is and keeps its wording** — it is the roadmap's
sentence and the roadmap is the one mount it was ever true of. The other three are new keys in their own
namespaces, which is the same line the opt-in props draw: **the foundation renders the string, the
consumer owns it** (Part IX §5).

**The fifth mount needs no string and that is a decision, not an omission.** `ChildPanel` passes
`searchable={false}` on purpose (_"a `/` overlay inside an embedded panel is a page-level key grab"_).
Recorded so nobody adds a sixth string for it.

## 6. §6 · The DERIVED default — and the floor this surface CANNOT reach

⚠️ **This §'s output is a PREDICATE, and it is the one thing on this card the code children may not
decide for themselves.**

### What ships, and the half it is blind to

`defaultPlanView` is `planContainerCount(items) > 1 ? 'list' : 'canvas'` (Part IX §3). It sees a plan
SPREAD across containers and is blind to a plan CROWDED inside one — which looks identical to the reader
and is worse, because the cards are somewhere on the level rather than honestly absent.

### The arrival scale, MEASURED — 24 points, and a closed form that reproduces all of them

`arrivalView` is `fitView` with a floor. For a level of `N` sibling nodes with no intra-level
dependency edges — the shape a plan-review level takes — `deterministicLayout` drops them into a
**3-column grid**: `NODE_W`/`NODE_H` = 280×124, `GAP_X` 80, `GAP_Y` 72, `COLS` 3, `ORIGIN` 40. So

```
bw = (min(N, 3) - 1) * 360 + 280        // 1000 for every N >= 3
bh = (ceil(N / 3) - 1) * 196 + 124
scale = clamp(min((W - 96) / bw, (H - 96) / bh), MIN_SCALE = 0.3, MAX_SCALE = 2)   // padding 48 each side
```

Measured in Chromium against the shipped box, six levels × four viewports. The closed form reproduces
**every one of the 24** to the fourth decimal:

| N (level total) | 1280×800 (622×522) | 1366×768 (708×498) | 1440×900 (782×622) | 1920×1080 (1262×802) |
| --------------- | ------------------ | ------------------ | ------------------ | -------------------- |
| 6               | 0.526              | 0.612              | 0.686              | 1.166                |
| 12              | 0.526              | 0.5646             | 0.686              | 0.9916               |
| 18              | 0.3859             | 0.3641             | 0.4764             | 0.6395               |
| 24              | **0.300**          | **0.300**          | 0.3516             | 0.4719               |
| 30              | **0.300**          | **0.300**          | **0.300**          | 0.3739               |
| 42              | **0.300**          | **0.300**          | **0.300**          | **0.300**            |

Bold is `MIN_SCALE`. At 0.30 a node card is **84 px wide** (measured) and its title renders at 4.2 px.

### ⚠️ THE FLOOR IS NOT REACHABLE ON THIS SURFACE, and the card's question therefore has no answer

`ARRIVAL_MIN_SCALE = 0.80` was derived for the ROADMAP, whose canvas is the full content width. **This
canvas is the `1fr` of a `grid-cols-[1fr_22rem]`**, so the rail takes 352 px of it: 782 px wide at
1440×900, 708 at 1366×768, **622 at 1280×800**.

**The width term alone caps the arrival scale, before the level's height is considered at all:**

| viewport  | canvas W | width term `(W − 96)/1000` | ≥ 0.80? |
| --------- | -------- | -------------------------- | ------- |
| 1280×800  | 622      | **0.526**                  | no      |
| 1366×768  | 708      | **0.612**                  | no      |
| 1440×900  | 782      | **0.686**                  | no      |
| 1920×1080 | 1262     | 1.166                      | yes     |

So **at three of the four viewports NO level of three or more nodes can arrive at or above the floor**,
whatever this story does — the measured `0.686` at 1440×900 with SIX nodes is already the ceiling.
Asking "how many nodes can a level hold and still arrive at or above the floor?" answers **two** at
1440×900, which would send every plan to the list. **That is the card's premise falsified, and the
predicate below is derived from what the measurement does support.**

### THE PREDICATE — the arrival level's TOTAL node count, and the number is 12

**A level arrives as well as this canvas can arrive when it is no more than FOUR ROWS — 12 nodes.**

Derivation, using the canvas viewports §2 produces:

| viewport  | canvas vp after §2 | width term | 4 rows (`bh` 712) | 5 rows (`bh` 908) | at the ceiling up to                                |
| --------- | ------------------ | ---------- | ----------------- | ----------------- | --------------------------------------------------- |
| 1280×800  | 622×621            | 0.526      | 0.737             | 0.578             | 5 rows                                              |
| 1366×768  | 708×589            | **0.612**  | **0.692**         | 0.543             | **4 rows**                                          |
| 1440×900  | 782×721            | 0.686      | 0.878             | 0.688             | 5 rows                                              |
| 1920×1080 | 1262×901           | 1.166      | 1.130             | 0.886             | 3 rows (and 5 rows is still 0.886, above the FLOOR) |

- **12 is the largest count that is still at the canvas's own ceiling at the tightest viewport**
  (1366×768), and it is at or above the ceiling at 1280×800 and 1440×900 too.
- **At 1920×1080 the rule costs nothing**: 12 nodes arrive at 1.130, and even 15 arrive at 0.886 — both
  far above the 0.80 floor, so the one viewport where the floor IS reachable never hits the predicate.
- **Above 12 the fall is steep and measured**: 18 nodes arrive at 0.364 at 1366×768; 30 nodes are
  clamped to `MIN_SCALE` at three of the four viewports; 42 at all four.

### The SECOND arm — a level past `TREE_LEVEL_MAX_TAKE`

`workItemsService` caps every level read at **`TREE_LEVEL_MAX_TAKE = 200`** rows under a **key-ASCENDING**
sort, so overflow discards the **HIGHEST keys** — the most recently created cards
(`WorkItemNode.tsx:583`, MOTIR-3490). **A `modify` or `remove` targets a committed work item, and the
most recently created cards are exactly the ones a plan is most likely to be about**, so on a level of
more than 200 the plan's own target can be truncated away entirely: the canvas draws 200 cards, rings
none of them, and the reviewer sees a plan whose subject is not on the screen.

**So: an arrival level whose UNTRUNCATED total exceeds `TREE_LEVEL_MAX_TAKE` opens in the LIST,
unconditionally** — before the node-count arm is even consulted. This raises no cap and changes nothing
about what a level contains; `mergePlanLevel`, the take and the "Show all" ceiling are untouched.

### TOTAL, not the plan's SHARE — and why

The predicate reads **the arrival level's total node count** — its committed children ⊕ the plan's own
proposals under that parent — **not the number of cards the plan proposes.** The arrival scale is a
function of how many nodes the level DRAWS; a plan of three cards under a container of two hundred
committed siblings is the exact case this § exists for, and its share is three. Reading the share would
answer a different question and would be blind to the only one that matters.

### What the code card needs, and what it must not do

```
defaultPlanView(review) =
  review.arrivalLevelTotal > TREE_LEVEL_MAX_TAKE ? 'list'      // the truncation arm
  : review.arrivalLevelSize > 12                 ? 'list'      // the legibility arm
  : planContainerCount(review.items) > 1         ? 'list'      // Part IX §3, unchanged
  : 'canvas'
```

- **`arrivalLevelSize` / `arrivalLevelTotal` reach the client on `PlanReviewDto`** — the size of the
  level `arrivalLevel(items)` picks, and its untruncated total. The service already resolves that
  parent; nothing new is read.
- **`planContainerCount` keeps its single implementation** (`lib/planning/planShape.ts`). This adds a
  term, it does not fork the question.
- **Every property Part IX §3 fixed survives**: the default writes a CLEAN url; it is a SEED read once
  at mount, so a `generating` plan crossing a threshold under the 2.5 s poll never moves the reader
  between views.
- **12 is this Part's number and the code card does not re-derive it**, exactly as `ARRIVAL_MIN_SCALE`
  is the roadmap design's number and `canvasGeometry.ts` does not re-derive that one.

### ⚠️ The assumption in the closed form, stated with its direction of error

The grid formula is the EDGELESS layout. A level whose nodes carry intra-level `blocked_by` edges is
laid out as a layered left-to-right flow instead, which can be wider and shorter. **The predicate is
about the level's SIZE and must be computable before the canvas has drawn anything** — the card requires
that, and a layout-aware predicate would need the layout it is choosing whether to show. The grid is the
shape a plan-review level takes in the overwhelming majority of cases (committed siblings under one
container rarely all block one another), and where it is wrong it is wrong in the direction of showing
the LIST for a level the canvas could have held — which costs a click on the switcher, not a reader
staring at 84 px cards.

## 7. §7 · A LIST ROW opens its proposal — and the modal gets ONE close

`PlanProposalList.tsx`'s `ProposalRow` is an inert `<li>`: no handler, no role, no key binding.
`ProposalQuickView` is built and shipped and `PlanReviewCanvas.tsx:381` is its only mount — **the list
is the one body of the two that can say what a card contains, and the only one that cannot open it.**

### The row's activation — ONE control per row, and the `<dl>` stays valid

**The row's TITLE becomes a `<button type="button">` with a stretched hit area**; the `<li>` is
`relative`, the button carries `after:absolute after:inset-0`, and the ring is drawn on the ROW via
`focus-within`. Four things fall out of that and each was a constraint:

| constraint                                                                    | how this satisfies it                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **it may not become a row of BUTTONS** (the shipped listbox-rows a11y lesson) | exactly ONE interactive element per row, one tab stop. The chips and the change lines are not controls and do not become any                                                       |
| **the change lines are a `<dl>`**                                             | `<button>` takes phrasing content only, and a `<dl>` is flow — so the `<dl>` stays a SIBLING of the button inside the `<li>`, and the stretched `::after` still makes it clickable |
| **it must be keyboard-reachable**                                             | a real `<button>`: Tab reaches it, Enter and Space activate it, `Escape` closes the modal and focus returns to it (the shipped `Modal`'s own focus return)                         |
| **the whole row should be the hit area**                                      | the `::after` overlay, which is what lets the row read as one target without wrapping content the button may not contain                                                           |

**The shipped grammar this follows:** `ChildList`'s row is an `<li>` holding ONE full-row interactive
element that wraps the glyph, key, title and chips (`RelationshipPeekLink`). This is that shape with a
`<button>` where the `<a>` is — **because a proposal has no page and therefore no `href`**, which is the
one place the two rows must differ.

| state        | treatment                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **rest**     | today's row, unchanged                                                                                                                  |
| **hover**    | `--el-surface` row fill + the title underlined — `ChildList`'s own `group-hover:underline`, verbatim                                    |
| **focus**    | `ring-2 ring-(--focus-ring-color)` on the ROW, via `focus-within`, so the ring frames the whole target rather than the title's text box |
| **pressed**  | `--el-surface-soft` row fill                                                                                                            |
| **disabled** | there is none — every proposal has a body to read, including a `remove`                                                                 |

**The accessible name.** The button's own text is the title; it carries
`aria-label` = `planReview.rowOpenAria` → **`Open {name}`**, where `{name}` is
`<identifier> · <title>` for a `modify` / `remove` and **`New · <title>`** for an `add` — the same
`New` the node's crumb and the quick view's head already use (`planReview.proposedCrumb` / `newItem`),
so a card with no key is named the way this surface already names it. The visible title is contained in
the accessible name (WCAG 2.5.3).

**It opens the SAME modal the canvas's View pill opens** — `ProposalQuickView`, one mount lifted to the
island so both bodies use it. The list does not gain a second read view.

### ⚠️ The DOUBLE CLOSE — MEASURED, and the convention is FOLLOWED

Rendered, on a proposal opened from the canvas at 1440×900 — the dialog contains **two buttons whose
accessible name is `Close`**:

| control                             | rect                 | source                                         |
| ----------------------------------- | -------------------- | ---------------------------------------------- |
| the header's `QuickViewCloseButton` | x 1107, y 124, 36×36 | `ProposalQuickView.tsx:85`                     |
| the base `Modal`'s corner ×         | x 1147, y 98, 24×24  | `Modal.tsx:188`, rendered because `!hideClose` |

Two × glyphs 40 px apart horizontally and 26 px apart vertically, diagonally adjacent in one corner —
**and two identically-named controls in one dialog, which is the a11y half of the same defect.**

**`ProposalQuickView` passes `hideClose` and keeps its header button.** That is what its siblings do —
`IssueQuickView`, `WorkItemQuickView` and `AttachmentPreview` all pass `hideClose` — and the header
button is the one the quick-view family's own chrome (`QuickViewSurface`) is built around. **Departing
from the convention here would need a reason this surface does not have**, and the reason to follow it
is that a reader who has closed one quick view has closed all of them.

## 8. §8 · The rail LANDS ON ITS DECISION

`PlanReviewRail.tsx:163` is ONE `overflow-y-auto` column — status, title, summary, meta, timeline,
composer, then Approve and Decline at the very bottom of it, held there by `mt-auto`.

### What that costs, MEASURED, with a long generated title and a nine-turn timeline

| viewport  | rail visible | rail scroll height | Approve's bottom (scroll space) | below the fold by |
| --------- | ------------ | ------------------ | ------------------------------- | ----------------- |
| 1366×768  | 542          | 1011               | 1037                            | **361 px**        |
| 1280×800  | 566          | 1011               | 1037                            | **337 px**        |
| 1440×900  | 666          | 1011               | 1037                            | **237 px**        |
| 1920×1080 | 846          | 1011               | 1037                            | **57 px**         |

**On a 1920×1080 display, with nine timeline turns, Approve is still below the fold.** At 1366×768 the
rail shows the title and the history and nothing else — no Approve, no Decline, no composer, no hint.
**The page a reviewer arrived at to make a decision shows no decision, and nothing scrolls to it.**

The mirror case is visible too: on a SHORT plan `mt-auto` bottom-anchors the block, so the rail renders
its content, a large void, and then the decision. Both are the same missing rule — nothing owns where
the decision SITS.

### THE SPEC — the rail becomes a scroll region plus a pinned footer

```
<aside>                      flex column, min-h-0, NOT itself a scroller
  <div class="flex-1 min-h-0 overflow-y-auto">   the TRANSCRIPT
     status · title · summary · meta · HISTORY · staleness · the revise composer
  </div>
  <footer>                   pinned, shrink-0, --el-surface, border-t --el-border
     the error line · the outcome line · Approve · Decline · the one hint
  </footer>
</aside>
```

| decision                                 | answer                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **a top border, or a shadow?**           | **a top hairline (`--el-border`), no shadow.** The footer's fill is `--el-surface` — the rail's own — so a hairline is the whole separation needed. A shadow implies the footer floats over a different surface, which it does not, and this tree spends shadow on cards and popovers                                                                                                                                   |
| **does the composer come with it?**      | **NO — it stays at the END of the transcript.** A pinned footer must have a bounded height and a composer grows with its draft. And the reader still meets it immediately before the verbs, because the transcript opens at its bottom (below)                                                                                                                                                                          |
| **is Part XII §A honoured?**             | **Yes, in the reading it made.** §A put the composer _"INSIDE the decision block, above the two verbs"_ — an ORDER and an adjacency, and both survive: composer last in the transcript, verbs directly beneath it in the footer. What changes is scroll behaviour, not sequence                                                                                                                                         |
| **where does the transcript open?**      | **at its LATEST turn** — scrolled to the bottom on MOUNT, and again when a revision lands (the one event that appends a turn while the reader is on the page). Not a general stick-to-bottom: nothing else appends under a reader's eyes                                                                                                                                                                                |
| **1366×768, where the rail is shortest** | after §2 the rail is **635 − 2 = 633 px** (from 542). The footer is **152 px** — Approve 40, gap 8, Decline 40, gap 8, hint 16, padding 20/20 — leaving **481 px of transcript**, against 1011 px of content. It scrolls, which is correct, and the decision is on screen the whole time                                                                                                                                |
| **the ORB**                              | the footer reserves it: `padding-bottom: calc(var(--spacing-control-y) + var(--shell-bottom-clearance, 1.5rem))`. Measured at 1440×900 the orb's top is **824** and the rail's bottom becomes **900**, so without this the orb covers the bottom **76 px** — the Decline button. With it the lowest control's bottom is **798**, clear by 26 px. It reads the SHELL's property directly, not `--canvas-fold-inset` (§2) |

### The footer per `PlanStatus` member — all five, because a state set is run whole

| status       | the footer holds                                                                                                                                | the transcript                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `generating` | Approve (disabled) · **Discard this plan** (`secondary`) · `discardHint`                                                                        | no composer — nothing to revise |
| `planned`    | Approve (`approveCta`, live) · Decline (`ghost`) · `approveHint`, or `approveHintStale` / `approveHintRevising` when either holds               | the composer, when `onRevise`   |
| `stale`      | Approve (live — a stale plan may still be approved) · Decline (live) · the `plan-stale-outcome` line **above** the hint, then `staleReviewHint` | the composer                    |
| `approved`   | **`DecidedOutcome`** — no gate. The footer keeps its border and padding so the rail's shape does not change under the reader                    | the record                      |
| `declined`   | **`DecidedOutcome`** — same                                                                                                                     | the record                      |

**`DecidedOutcome` moves into the footer rather than being exempted from it**: it is the ANSWER to the
question the gate asks, it belongs where the gate was, and a rail whose bottom band appears and
disappears with the plan's status is a layout that moves for no reason the reader can see. **Nothing
about who may decide changes** — `ai:decide_plan` gates approve and discard exactly as today.

## 9. §9 · Copy — every string these panels introduce or change

Both catalogues are owed in the same pull request (the `zh` parity gate).

| key              | namespace           | en                                      | zh                         | introduced by |
| ---------------- | ------------------- | --------------------------------------- | -------------------------- | ------------- |
| `searchLabel`    | `planReview`        | Search this plan                        | 搜索本计划                 | §5            |
| `searchLabel`    | `planningWorkspace` | Search this project                     | 搜索本项目                 | §5            |
| `searchLabel`    | `onboarding`        | Search this project                     | 搜索本项目                 | §5            |
| `search`         | `roadmap.canvas`    | Search the roadmap — **UNCHANGED**      | 搜索路线图 — UNCHANGED     | §5            |
| `showChangesAll` | `planReview`        | Every item on this level is this plan's | 此层级的每一项都来自本计划 | §3d           |
| `rowOpenAria`    | `planReview`        | Open {name}                             | 打开 {name}                | §7            |

**No new string for the locate control** (§4 reuses `roadmap.canvas.showChangesNone`, `locateCurrent` /
`locateNextReady` / `locateReady` / `locateNothing` and `showChangesCount` unchanged), **none for the
pinned footer** (§8 moves shipped controls and reuses every shipped hint), and **none for the proposed
title** (§1 changes which value a shipped field carries).

Full non-`en`/`zh` locale parity follows the project's batch locale cadence rather than a per-feature
`translate` card — six strings, the same justified deviation MOTIR-3833 recorded.

## 10. §10 · a11y

- **The list row** is a real `<button>` — one per row, one tab stop, Enter and Space, and the focus ring
  drawn on the ROW so it frames the target rather than the title's text box. Its accessible name is
  `Open {name}` and contains the visible title (WCAG 2.5.3). The chips stay non-interactive text; the
  change lines stay a `<dl>` and are reachable as content, not as controls.
- **The quick view has ONE close** (§7), which also removes two identically-named controls from one
  dialog. Focus returns to the row's button on `Escape` — the shipped `Modal`'s own behaviour, which is
  why the row is a button and not a `div` with a handler.
- **The locate control's label at each state** is the shipped set, unchanged: enabled it reads
  `locateNextReady` while cycling and `locateReady` for one target; disabled it carries the reason as
  `title` and as its accessible description, and the reason on this surface is the level one
  (`showChangesNone`), not `locateNothing` — one sentence per situation.
- **The emphasis armed at arrival is announced, not inferred.** The toggle is a real `<button>` carrying
  `aria-pressed="true"` from first paint, so a screen-reader user is told the mode is on **without
  anybody having pressed anything** — which is precisely the case a visual pressed treatment cannot
  cover. Disabled, it carries its reason as `aria-description` (§3d). **The emphasis is never colour
  alone**: a ringed node carries its own `op` badge, which is TEXT, and the dim is a second non-hue
  channel (Part IX §L8, unchanged).
- **The pinned footer is inside the rail's own `<aside aria-label>` landmark**, after the scrolling
  region, so the reading order is transcript → decision — the order the page is about. It is not a
  `role="contentinfo"`: that is the page's footer landmark and there is one per document.
- **Motion**: unchanged from Part IX §L8 — the emphasis transition is dropped entirely under
  `prefers-reduced-motion: reduce`, which matters more now that it fires on arrival.

## 11. §11 · GIVES / TAKES — swept over the story SUBTREE

**TAKES** (elements, structures and premises):

- **Part IX §3's default rule — a PREMISE, WIDENED not replaced** (§6). The container-count arm is kept
  verbatim; two arms are added ahead of it. Part IX's asset is not re-exported.
- **⚠️ Part IX §L6's second bullet — a PREMISE, REVERSED** (§3d): the all-proposals level was _enabled,
  and harmless_; armed on arrival it is DISABLED with its own reason. Recorded here, asset frozen.
- **⚠️ Part IX §L1's `--el-accent-soft` sentence — an ELEMENT, CORRECTED** (§3e). The token does not
  exist; the fill is `--el-tint-lavender`. Corrected in the notes in this same pull request (the corrections table below).
- **Part IX §L1's placement, §L2's set, §L3's ring + `opacity-35` dim, §L4's selection rule, §L5's
  off-level count, §L7's decided tense, §L8's a11y and motion — ELEMENTS and PREMISES, all unchanged.**
- **Part VIII §2's 44 px pane header and its `Segmented` switcher — a STRUCTURE, composed** (§2's
  viewport arithmetic subtracts it; nothing about it changes).
- **Part VIII §3's row grammar and its SIGNAL-vs-SPELLED split — a PREMISE §1 honours** and §7 extends
  with one control.
- **Part VI's _the decided pane holds a RECORD_ — a PREMISE, EXTENDED twice**: to the armed emphasis
  (§3c) and to the footer, which keeps its band on a decided plan (§8).
- **Part XII §A's _the composer sits inside the decision block, above the two verbs_ — a STRUCTURE,
  PRESERVED in reading order and changed in scroll behaviour** (§8).
- **Part V §3's quick view — an ELEMENT, reused verbatim** and given one close (§7).
- **`design/roadmap/design-notes.md`'s full-fold section and `ARRIVAL_MIN_SCALE = 0.80` — a STRUCTURE
  and a NUMBER, both cited; §2 follows the pattern with a different inset answer and §6 measures why the
  number cannot bind here.**
- **`ChildList`'s row — an ELEMENT**, whose one-interactive-element-per-row shape §7 copies.
- **`components/ui/Sidebar.tsx`'s active-destination treatment — an ELEMENT**, which §3e reuses as the
  toggle's ACTIVE fill.

**GIVES** — every card in this story's subtree, and every one of these is written onto that card's
acceptance criteria in this same pass:

| card                                                    | takes                                                                                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4018** — a `modify` shows the title it proposes | **§1 whole**: the model change, the node's disposition, the list headline + change line, the untouched key, and the quick-view carve-out                                                     |
| **MOTIR-4019** — the pane fills the fold                | **§2 whole**: the measured budget, the `--height-control` term, the `calc`, the negative margin, the per-viewport table, and **the NO-`--canvas-fold-inset` decision**                       |
| **MOTIR-4020** — lit on arrival + the locate walk       | **§3 and §4 whole**, including **§3d's reversal of Part IX §L6** and **§3e's `--el-tint-lavender` fill and the correction of Part IX §L1**                                                   |
| **MOTIR-4021** — the search box names its canvas        | **§5 whole**: the required-with-`searchable` prop, the four mounts by name, the fifth that needs none, and the six strings                                                                   |
| **MOTIR-4022** — a list row opens its proposal          | **§7 whole**: the stretched-button shape, the `<dl>` constraint, the five states, the accessible name, and **`hideClose`**                                                                   |
| **MOTIR-4023** — the rail lands on its decision         | **§8 whole**: the two-region rail, the footer's contents and border, the composer's place, the mount-time scroll, the measured 1366×768 budget, **the orb inset**, and the five-status table |
| **MOTIR-4024** — the derived list default               | **§6 whole**: the measured table, **the number 12**, the truncation arm, TOTAL-not-share, the two new `PlanReviewDto` fields, and the closed form with its stated assumption                 |
| **MOTIR-4025** — the story vitest gate                  | the arithmetic to pin (§6's closed form and the 12), §1's model seam, and §3d/§4's two degenerate levels — the cases a coverage percentage cannot see                                        |
| **MOTIR-4026** — the acceptance E2E + video             | the eight steps of the story's verification recipe, with §2's and §8's numbers as the assertions and §6's crowded level as the fixture                                                       |

## ⚠️ Corrections this Part makes to earlier Parts (all in the notes; no asset is re-exported)

| Part       | sentence                                                              | correction                                                                             |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **IX §L1** | _"ACTIVE takes `--el-accent-soft` fill"_                              | the token does not exist. The ACTIVE fill is **`--el-tint-lavender`** (§3e)            |
| **IX §L6** | an all-proposals level is _"enabled, and ON simply rings everything"_ | **DISABLED**, with its own reason, once the control is ARMED rather than pressed (§3d) |
| **IX §3**  | _"the LIST when the proposals sit under more than one container"_     | **kept, and widened** by two arms ahead of it (§6)                                     |

**⚠️ AND FOUR OF THIS PART'S OWN CLAUSES ARE AMENDED BY THE BUILD (MOTIR-4016's parent run), on the record rather than quietly:**

| §         | what this Part said                                                     | what shipped, and why                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§5**    | the plan-change canvas's key is `planChange.searchLabel`                | **`planningWorkspace.searchLabel`** — no `planChange` namespace exists; that feature's strings live under `planningWorkspace`. A namespace this Part named without checking                                                                 |
| **§4/§9** | the locate control reuses the shipped `locateNextReady` / `locateReady` | **a consumer-supplied `locateLabel`** — `planReview.locateChange`, _"Locate the next of this plan's items"_. The shipped strings name a READY frontier, which a proposal never is; reusing them would ship §5's own defect one control over |
| **§7**    | the quick view is ONE mount lifted to the island                        | mounted in the LIST. The two bodies are mutually exclusive, so two mounts can never both be open, and the canvas's peek state is a compound one a list row can only ever be half of. What §7 is about — no SECOND read view — holds         |
| **§7**    | focus return is the shipped `Modal`'s                                   | **explicit**. The dialog unmounts in the same commit that re-renders the rows, so the shipped restore lands before the row is settled and a keyboard user was returned to nothing. Found by the acceptance walk, fixed in MOTIR-4022        |

## 12. §12 · Access path

**Unchanged, and this Part adds no entrance.** `/plans/[id]` is reached exactly as Part I §5 draws it —
the **Plans** primary left-nav entry, then a row on the tabbed list (Part VII). Panel 0 of the asset
draws that door at real size, with the row that leads here, because a design that does not draw its
entrance leaves the reader to find it.

**Two doors this Part changes the STATE of rather than adding:** the canvas's Show-changes toggle now
arrives pressed, and the list row becomes a door onto the quick view that the canvas's **View** pill
already was. Neither is a new route, a new nav affordance or a new modal.

## 13. §13 · What Part XIII does NOT draw

The canvas engine and its node treatments; the three `op` languages; the drill / breadcrumb / zoom /
full-screen mechanics; `WorkItemNode`, `PlanItemNode` and the inline diff overlay; the List ↔ Canvas
switcher itself (Part VIII); the establish band and `approvePlan` / `materialize`; the plan timeline's
content events (Part X); the revision flow (Part XII); `WorkItemQuickView` (§1); the `/plans` index
(Part VII); what a LEVEL CONTAINS — `mergePlanLevel`, `TREE_LEVEL_MAX_TAKE` and the "Show all" ceiling
are read by §6 and changed by nothing; and any change to who may decide a plan.

## How this asset was produced (reproduced here, because the harness is deleted)

The mock's stylesheet IS Tailwind's real output for this document, and its markup is composed in the
app's own utility classes against the dumped markup of the shipped components. **No token is declared
locally** — the defect in §3e is what that rule exists to prevent.

```js
// .scratch4017/input.css  →  postcss  →  inlined verbatim into the mock's <style>
//   @import 'tailwindcss' source(none);
//   @source '../design/ai-planning/plan-detail-refined.mock.html';
//   @import '@motir/design-system/theme.css';
postcss([require('@tailwindcss/postcss')]).process(css, { from: inputPath });
```

```ts
// a throwaway Playwright spec under tests/e2e/, deleted before the commit, driven against
// `next build && next start` on a private Postgres, seeded with the SHIPPED fixture:
//   seedPlanShapes(email)  — tests/e2e/_helpers/plans-shapes-seed.ts, shape TWO
// per viewport: page.goto(`/plans/${planId}`) then getBoundingClientRect() +
//   getComputedStyle() on the real elements; the arrival scale read off
//   new DOMMatrixReadOnly(getComputedStyle('[data-testid="canvas-world"]').transform).a
// the crowded levels: N committed stories under one epic + a two-proposal plan, N in
//   {4, 10, 16, 22, 28, 40}, measured at all four viewports — the 24 points in §6
// the long rail: the SHIPPED rail with its <h2> text replaced and eight timeline rows
//   cloned, so the measurement is the real component under longer content
```

**The both-themes check was run in Chromium, not inferred**: the board rendered at
`<html data-theme="dark">` with the toggle, the list body and the node cards reading correctly — the
dark `--el-tint-lavender` (`#2a253a`) fill and `--el-accent-on-surface` ink both resolve from the
shipped layers. No nested dark scope is committed, for the reason panel 9 records.

Measurement at `deviceScaleFactor: 1`; the PNG is re-exported with the shipped
`node scripts/render-design-mock.mjs design/ai-planning/plan-detail-refined.mock.html`, **after**
`prettier --write` on the mock.

## ⚠️ Planning flags — surfaced by this pass, owned by no card in MOTIR-4016

1. **`ARRIVAL_MIN_SCALE` is a ROADMAP number applied to a canvas the roadmap does not own.** §6 measures
   that it is unreachable on the plan detail at three of four viewports, and `OnboardingCanvas` /
   `PlanChangeCanvas` mount the same component in the same two-pane shell — so the same is true of them
   and nothing says so. Whether the floor should be per-mount, or whether `deterministicLayout`'s fixed
   `COLS = 3` should respond to the viewport (the roadmap's own flag 1, still open), is a decision
   nobody has made. Outside this story's boundary.
2. **`min-h-[34rem]` is untouched and still binds on a short window.** §2 stops it binding at 1366×768,
   but a shorter window still meets a floor taller than its own `calc`, on a shell that promises not to
   scroll. Same open question the roadmap recorded, now on a second surface.
3. **A mock that declares LOCAL token names can put a non-existent `--el-*` into production** (§3e), and
   the four earlier `design/ai-planning/*.mock.html` assets all do it. Nothing checks that an `--el-*`
   named in a design note resolves in `theme.css`. That check is a guard-lane test, not a design card.
4. **The node's inline diff overlay fails AA on `main`** — `--el-text-muted` at `text-xs` on
   `--el-surface`, 4.12–4.34:1 (§1). Filed as a bug; outside this story's boundary, which leaves the
   node treatments as drawn.
5. **The dark-parity guard's `data-appearance-scope` escape hatch does not hold under happy-dom.**
   `tests/design-dark-parity.test.ts` renders with an engine that does not resolve `var()`, so an asset
   embedding the real `theme.css` still reads `--el-page-bg` as unset on a nested dark scope — and the
   only way to pass is the concrete-hex re-declaration §3e argues against. This asset therefore draws no
   nested dark scope (panel 9 says so). Whether that guard should render in Chromium, as the ink guard's
   own scan does, is a decision nobody has made.

---

# Part XIV — The SHIPPED peek in PROPOSAL MODE: the per-op header, the CHANGED marker, the explanation with no page to defer to, and what an un-materialized `add` cannot show (MOTIR-4182 / Story MOTIR-4181)

> **Amended by Part XXVIII §28.6 (MOTIR-8591, 2026-10-15).** On the planning overlay while a plan is
> `generating`, a title, description or explanation that was empty when this peek opened TYPES IN when
> it arrives. Its layout, its empty treatment and every other row of this Part are unchanged.

**Its OWN asset**: `design/ai-planning/peek-proposal-mode.mock.html` + `peek-proposal-mode.png`, plus
this section. Part V §3 — which decided that a proposal is READ with the shipped quick view — stays
exactly as drawn; this Part is what that decision becomes once BOTH doors use it and all three ops
arrive (_A design result is a MOMENT_, above).

**Why the story leads with a design.** `ProposalQuickView` is a SECOND peek. It exists because, when
it was written, a proposal peek could only ever be opened on an `add`; [MOTIR-4022](motir:cmtgaukpn0006hwn86ttsr1mu)
made a list row a door and that premise became false. Every field the review model carries has since
had to be walked across the `op` axis by hand, one report at a time —
[MOTIR-4134](motir:cmtj5u1g40109hvph31dpb4mz) for both bodies,
[MOTIR-4143](motir:cmtjzu6do000bhvphdqtaf8ag) for the rail — and `explanationSource`,
`planningProvenance` and `status` are still `add`-only. **This Part draws the collapse**:
`IssueQuickViewPanel` gains a PROPOSAL MODE, both doors route to it, and the second surface is
deleted.

## 0. Drawn against SHIPPED reality — what was RENDERED first, and what the render settled

Every panel is composed in the app's own utility classes against the **dumped markup of the shipped
components**, taken from the running application at `origin/main` @ `68685ad3a` on a seeded plan
carrying one `add`, one `modify` and one `remove`, each with a real multi-paragraph `descriptionMd`
and `explanationMd` — not a redraw. **Every number is measured in Chromium at 1440×900.** The harness
is reproduced in §15 rather than cited, because it is deleted before this asset lands.

**What the render settled, and two of the four could not have been read off the source:**

| what was rendered                         | what it settled                                                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the same `modify`, opened from BOTH doors | the list door renders **3** rail rows and the canvas door **12**, for one work item in one plan (§1)                                                                                                 |
| `ProposalQuickView`'s rail                | it prints **raw wire values** — `highest`, not the shipped `↑↑ Highest` priority chip; `8`, not the estimate grammar — because it composes `QuickViewRailField` without the shipped VALUE components |
| the shipped peek with a long body         | main 626×613 holding **933**, rail 300×613 holding **832**. The peek's rail ALREADY overflows by 219px on an ordinary card, which is what makes §3's pinned line a decision rather than a preference |
| `ProposalQuickView` on the `remove`       | **2** rail rows, no status, no `line-through`, and **nothing anywhere that says approving will archive the card** — the one thing a `remove` peek exists to say (§8)                                 |

**A fifth thing the render settled, and it corrects a premise this Part started with.** The shipped
rail shows no `Type` / `Executor` row on a `story`: they are leaf-only (`isTypeableKind`), so the
twelve rows above are what a container-kind card gets and a `subtask` gets fourteen. **The row set is
already a function of the SUBJECT, not of the surface** — which is the whole of §1's answer, and it is
a fact about the shipped component rather than an argument this Part makes.

## 1. §1 · The premise — ONE component, and why the rail is still allowed to be shorter

**The peek a proposal opens IS the peek a work item opens.** `IssueQuickViewPanel` gains a mode;
nothing composes a second surface out of `QuickViewSurface` again. Every decision below is a
consequence of that rather than a separate choice.

**The objection to answer first.** If the two surfaces are one, a reader might expect the same rail
rows a work item gets. They will not always get them — and that is the component behaving as it
already does:

- the shipped rail is **already data-driven**: `Type` and `Executor` are leaf-only (measured above),
  `Sprint` is omitted for an epic, custom fields split into valued rows and a `Show more fields (N)`
  disclosure, and the readiness banner is suppressed past the `todo` category;
- so **a row's absence is a statement about the SUBJECT, never about the surface**.

**What makes that honest rather than convenient is §2's merge**: on a `modify` / `remove` the peek
renders the TARGET's own core-field set — the same rail `/items` draws — so the canvas door loses
nothing it shows today. Only an **un-materialized `add`** is short, because there is no other card to
read from.

## 2. §2 · The PROJECTION — a merge for `modify` / `remove`, the proposed fields alone for an `add`

The projection answers one question: **what will this work item BE if this plan is approved?** Three
sources, and the op decides which exist:

| op                          | base                              | overlay                                 | result                                                                         |
| --------------------------- | --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| **`add`** (un-materialized) | none — there is no card yet       | the proposal's `PlanItemProposedFields` | every value is proposed, and every absent row is a field **no plan can carry** |
| **`modify`**                | the TARGET's live `QuickViewData` | the patch's own fields                  | the card as it will stand, with the changed fields MARKED                      |
| **`remove`**                | the TARGET's live `QuickViewData` | none — a `remove` carries no patch      | the card as it stands, marked nowhere, plus the archive statement              |

### ⚠️ AMENDED 2026-09-02, WHILE BUILDING MOTIR-4183 — the merge is RIGHT and its OWNER was wrong

The table above says the projection's base is the target's live `QuickViewData`. **The rendered result
it describes is correct and unchanged; where that merge HAPPENS is not.** Measured before implementing:

|                                         |                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `planReviewService.getPlanReview` today | reads every `modify` / `remove` target in **ONE batched, workspace-scoped read** — its own header comment says _"no N+1"_                 |
| `workItemsService.getQuickView`         | **~14 reads per item** (the detail aggregate, members, sprints, components, estimation config, the sprint name, the refs, the deliveries) |

So building the merge inside `getPlanReview` puts **~14 × N reads on the plan-review load** — roughly
280 for a plan with twenty `modify`s — to serve a peek the reviewer opens at most one of. That is a
surface whose no-N+1 property is stated in code, traded away for a panel that is closed.

**The merge therefore happens where the shipped peek already fetches: ON OPEN, in the client.**

| op                    | on open                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modify` / `remove`   | the host fetches the TARGET's payload from `GET /api/work-items/peek?key=<identifier>` — the request `WorkItemQuickView.tsx:75` and `IssueQuickViewController.tsx:70` already make — and overlays the proposal envelope |
| un-materialized `add` | **no key, so no fetch.** The envelope IS the payload; the short rail in §2's table is what that produces                                                                                                                |

**One request per opened proposal, which is what opening any work item costs today**, and the
plan-review read gains nothing but the envelope. §2's row-by-row table is unchanged — it describes what
the reader SEES, and they see the same thing either way.

**The boundary this moves:** MOTIR-4183 emits the **envelope** (`op`, the target's `identifier`, the
proposed values, `changedFields`, `settableFields`) and adds `explanationMd` to the payload — which is
what its own criteria already say, _"a small `proposal` envelope carrying what only a proposal has"_.
**MOTIR-4184 owns the overlay**, because the overlay is a render-time composition of two payloads and
that card is the one that mounts them. Neither card gains scope it did not have; the design had put the
join in the wrong half.

**Why a merge and not the proposal's fields alone.** Today a `modify` opened from the CANVAS renders
`WorkItemQuickView` — the target's full rail. A proposal mode built only from
`PlanItemProposedFields` would take `Assignee`, `Reporter`, `Labels`, `Components`, `Due date`,
`Sprint` and every custom field away from that door. **Collapsing two surfaces must not be a
regression on the one that was already right**; this is a re-shape precisely because neither door was
right on its own.

**Why the `add` arm is short, and why that is not the same defect returning.** An `add` has one
source, and `PlanItemProposedFields` is a CLOSED set held against `PlanReviewItemDto` by
`tests/dto/planReviewFieldParity.test.ts`. A row it cannot fill has no value to show and no card to
read one from; an empty-state row would promise that approval settles a field it never touches.

**The rail, row by row, in the shipped order.** _(m) = markable — the plan HAS a carrier for this
field._

| shipped rail row      | `add`                                                                                                | `modify`                                                                                            | `remove`                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------ |
| **Status**            | **SUPPRESS** — no card, so no status; the header's op chip is where the proposal's own state lives   | the target's live status, never marked                                                              | the target's live status |
| **Repositories**      | the PIN — `targetRepo ?? targetRepoRole` **(m)**                                                     | the target's `repoDelivery` set; marked when `patch.targetRepo` / `targetRepoRole` moves it **(m)** | the target's             |
| **Type**              | proposed **(m)**                                                                                     | merged **(m)**                                                                                      | the target's             |
| **Executor**          | proposed **(m)**                                                                                     | merged **(m)**                                                                                      | the target's             |
| **Priority**          | proposed **(m)**                                                                                     | merged **(m)**                                                                                      | the target's             |
| **Assignee**          | **SUPPRESS**                                                                                         | the target's, never marked                                                                          | the target's             |
| **Reporter**          | **SUPPRESS**                                                                                         | the target's, never marked                                                                          | the target's             |
| **Parent**            | proposed `parentIdentifier`, with the intra-plan marker when the parent is itself a proposal **(m)** | merged; marked when `patch.parentRef` re-parents it **(m)**                                         | the target's             |
| **Labels**            | **SUPPRESS**                                                                                         | the target's, never marked                                                                          | the target's             |
| **Components**        | **SUPPRESS**                                                                                         | the target's, never marked                                                                          | the target's             |
| **Due date**          | **SUPPRESS**                                                                                         | the target's, never marked                                                                          | the target's             |
| **Sprint**            | **SUPPRESS**                                                                                         | the target's, never marked                                                                          | the target's             |
| **Story points**      | proposed **(m)**                                                                                     | merged **(m)**                                                                                      | the target's             |
| **Estimate**          | proposed **(m)**                                                                                     | merged **(m)**                                                                                      | the target's             |
| **Custom fields**     | **SUPPRESS**                                                                                         | the target's valued rows + `Show more fields (N)`, never marked                                     | the target's             |
| **Created / Updated** | **REPLACED** — §3's foot line                                                                        | **REPLACED**                                                                                        | **REPLACED**             |

**`Sprint` is suppressed on an `add` for a reason worth writing down**: a plan has no sprint carrier at
all (`move_to_sprint` has no proposal form), so no approval can ever place a card in one. A row that
can never move is not an empty state; it is noise in a 300px rail.

### ⚠️ The rail's EMPTY VALUES take `--el-text-secondary`, and the asset could not reproduce the shipped markup

**The asset was built by reproducing the shipped rail verbatim, and the design-side ink guard rejected
it 23 times.** `QuickViewRail` is `bg-(--el-surface-soft)`, and two components it mounts paint their
empty value `--el-text-muted` — `RepositorySetField.tsx:97` (the `Repositories` row's `None`) and
`IssueQuickViewPanel.tsx:229` (`mutedNone`, every empty custom field). Measured from the shipped
tokens: `#787671` on `#fafaf9` is **4.34:1**, under AA; `--el-text-secondary` is **6.51:1**.

**So Part XIV specifies `--el-text-secondary` for every empty value in the rail** — the mock draws it
that way, and a build that follows this asset gets it right. This is a design DECISION, not the asset
diverging from reality by accident, and it is stated here because the mock and the running app
genuinely differ on this one class until the defect is fixed.

**The defect is filed as [MOTIR-4196](motir:cmtkjnfn100hbhxphx8o5s36b), not absorbed.** It is present on
`origin/main` independently of this story, it needs a failing test of its own, and it owes a sweep of
the rail's other mounted components — none of which belongs in a design card or in MOTIR-4184.
`tests/theme/inkContrastLint.test.ts`'s muted arm ABSTAINS on it by its own documented rule (the
surface is painted in a third module), which is why the tree is green and why a design pass is what
found it.

**⚠️ AMENDED 2026-09-02, WHILE BUILDING MOTIR-4183 — the first draft of this paragraph said NINE and
was wrong twice.** It counted `executor`, which a `modify` cannot patch, and it mixed rail fields with
body fields under a number the rail's own foot line reads. Both were settled by reading the TYPE and
`plansService.applyModify`, not the DTO's field list:

- **`PlanItemPatch` has no `executor` key** and `applyModify` never writes one. `executor` is settable
  on an `add` (`PlanItemProposedFields`, deepenable since `agent-authored-plans.md` AMENDMENT 4 D3a)
  and is the TARGET's on every other op. The row above is corrected to `add`-ONLY.
- **`targetRepo` / `targetRepoRole` ARE patchable** — and a grep for `patch.targetRepo` inside
  `applyModify` returns NOTHING, because they are applied through `repoPins`. A reader checking this
  the obvious way concludes the opposite of the truth, which is why it is recorded here.

**So the rail's denominator is SIX** — the rail rows a patch can move:

| #   | rail row     | patch key                                           |
| --- | ------------ | --------------------------------------------------- |
| 1   | Repositories | `targetRepo` / `targetRepoRole` (one row, two keys) |
| 2   | Type         | `type`                                              |
| 3   | Priority     | `priority`                                          |
| 4   | Parent       | `parentRef`                                         |
| 5   | Story points | `storyPoints`                                       |
| 6   | Estimate     | `estimateMinutes`                                   |

`title`, `descriptionMd` and `explanationMd` are patchable too and are **excluded on purpose**: they
are marked in the MAIN COLUMN, and a line at the foot of the rail that counted them would answer about
fields the reader cannot see from where the line sits. `blockedByAdd` / `blockedByRemove` are edges and
belong to the canvas (Part IX).

**The line therefore reads `2 of 6`.** It is COMPUTED from the patch key set rather than stated as a
constant, so a key added to `PlanItemPatch` moves it with no edit here — MOTIR-4183's criterion 9.

## 3. §3 · The CHANGED marker — `--el-diff-moved` — and the PINNED line that reads the silence

### The marker

**A rail row the plan CHANGES carries a `changed` chip beside its `LABEL`**, inside the `<dt>`, on the
caption's own line. It is the marker grammar this area already uses twice — the `AI-drafted` chip
beside `Why this matters` (`ProposalQuickView.tsx:141`) and `RevisionDiff`'s kind chip
(`RevisionDiff.tsx:69`) — at chip scale, so the row's height does not change.

```html
<dt class="… uppercase">
  Priority
  <span
    class="ml-1.5 inline-flex items-center rounded-(--radius-badge) bg-(--el-diff-moved)
           px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-semibold
           text-(--el-text-strong) normal-case"
    >changed</span
  >
</dt>
```

### The token — NAMED, not invented

| what                      | token                 | Tier-0 source      | light                                                 | dark      |
| ------------------------- | --------------------- | ------------------ | ----------------------------------------------------- | --------- |
| the `changed` chip's fill | **`--el-diff-moved`** | `--color-tint-sky` | `#dcecfa`                                             | `#1a2a3a` |
| its ink                   | `--el-text-strong`    | —                  | the AA ink every tinted chip in the tree already uses |           |

**`--el-diff-moved` is the right token by SEMANTIC, not by resemblance.** It is the shipped diff
family's own "changed" slot (`theme.css:3044`), and `RevisionDiff.tsx:53` already consumes it for a
chip whose word is literally `changed`. Nothing is invented, and no second vocabulary for _this moved_
enters the product.

**It also lands the same colour as the `change` op chip, by CONSTRUCTION rather than by coincidence** —
both resolve through `--color-tint-sky` — so the rail speaks the header's colour without either side
naming the other's value, and a palette that re-skins that source moves both.

**⚠️ The card asked for "a named Tier-0 token" and this names a Tier-3 one, deliberately.** Consuming
`--color-*` directly is forbidden (`CLAUDE.md`'s colour rule): a Tier-0 override is HOW a palette
re-skins, so a component that reads Tier-0 defeats the mechanism. The criterion's intent — _a shipped
colour, named in the asset, with its dark value stated, and no new hue_ — is satisfied above, and the
Tier-0 SOURCE is named beside it so the value stays checkable.

**Colour is never the only carrier.** The chip contains the word `changed`, inside the row's own
`<dt>`, so a screen reader announces _Priority changed_ rather than a loose chip a reader has to
associate by position.

### The SILENCE — one line, and it is PINNED

An unmarked row means one of two different things — _the plan carries this field and is not changing
it_, or _no plan can carry this field at all_ — and a marker cannot separate them without a second
marker on fourteen rows. **So the rail does not try; one line at the rail's foot does:**

| op                  | the line                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| **`add`**           | `Every value here is what approval will create.`                                     |
| **`modify`**, n > 0 | `This plan changes {n} of the {m} fields it can set.`                                |
| **`modify`**, n = 0 | `This plan changes none of these fields — only the description and the explanation.` |
| **`remove`**        | `Approving this plan archives {key}.`                                                |

**Naming the DENOMINATOR is what makes the silence readable.** `2 of 6` says both that four settable
fields are untouched and that everything outside the nine is beyond the plan's reach — which is what
the `add` arm's short rail and the `modify` arm's never-marked rows are each half of.

**⚠️ AND IT IS PINNED OUTSIDE THE SCROLLER, WHICH IS A MEASUREMENT RATHER THAN A PREFERENCE.** With
the line inside the rail's `<dl>` the column's content is **799px in a 613px track** — the shipped
peek's own condition (832 in 613 on the running app) — so **186px sit below the fold**, the line among
them, and so does the marked `Story points` row at y 616. Pinned, the scroller is 572 and holds 743:
**171px still below the fold, and the line always visible.** A line whose whole job is to be read as a
statement ABOUT the rows above it cannot live at the bottom of their scroller — a reader would read
twelve rows and never reach it, which is exactly the ambiguity this section exists to remove. Same
instrument and same reasoning as Part XIII §8's pinned decision.

**And it is what makes a marked row BELOW the fold safe**, which is the other half of the same
measurement: the reader is told there are two changes before they have scrolled to either.

**Why the audit line goes rather than moves.** `Created` / `Updated` on a proposal are the instants the
PLAN ROW was written — a fact about the plan, which the plan's own timeline (Part X) already carries
better. It also scrolled, and could: `Created` / `Updated` is a fact you go looking for; the count is a
fact you must not be able to miss.

**Rejected: reordering the rail so marked rows rise to the top.** The rail's order is settled and one
of its positions is itself a measurement (Part V / 8.8.8 put `Repositories` second because measured
last it fell below the fold). A reader who has learned where `Priority` sits should find it there
whether or not a plan touches it; the pinned line is what tells them to look further down.

## 4. §4 · The HEADER, per op — the op word takes the STATUS slot

The shipped header, left to right:

`IssueTypeIcon(kind)` · `identifier` (a link) · `StatusValue` · [`Archived` pill] · _spacer_ ·
`WorkItemPlanEntrance` · `Open full page →` · `QuickViewCloseButton`

Proposal mode, per slot:

| slot            | `add`                                                                                                            | `modify`                                                          | `remove`                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| kind glyph      | the PROPOSED kind                                                                                                | the target's kind                                                 | the target's kind                                                 |
| identifier      | **`New`**, same mono slot, unlinked — `planReview.newItem`, the word the node crumb and the list row already use | the target's key, linked as `/items` links it                     | the target's key, linked                                          |
| **status slot** | the OP CHIP — `not yet created`                                                                                  | the OP CHIP — `change` — **then** the target's live `StatusValue` | the OP CHIP — `remove` — **then** the target's live `StatusValue` |
| `Archived` pill | absent                                                                                                           | rendered when the target is archived                              | rendered when the target is archived                              |
| plan entrance   | **SUPPRESS** (§5)                                                                                                | **SUPPRESS**                                                      | **SUPPRESS**                                                      |
| the link out    | **ABSENT** (§7)                                                                                                  | present                                                           | present                                                           |
| close           | ONE — the header's `QuickViewCloseButton`, with `hideClose` on the `Modal` (§7)                                  |                                                                   |                                                                   |

**The decision the card asks for: YES, the op word sits where `/items` puts the status.** A status
answers _what state is this card in_; on a review surface the reader's question is _what will the plan
do to it_, and the op is the proposal's own state. It costs no new geometry and reuses the `Pill`
grammar the list row and the canvas node already speak: `add` → `Pill severity="info"`, `modify` →
`Pill status="planned"`, `remove` → `Pill tone="archived"` (`PlanProposalList.tsx:90-92`, unchanged).

**And on a `modify` / `remove` BOTH chips render, op first.** They are different facts and the surface
owes both — a reviewer approving a change to a card already `In Review` needs to know that. Left to
right the header then reads _what the plan does_ → _where the card is now_, which is the order the
decision is made in. An `add` has no status chip at all, so the two never crowd on the op whose word is
longest.

**No fourth vocabulary.** The op word is `planReview.opModify` / `opRemove` (`change` / `remove`), with
`notYetCreated` kept for the `add` arm — the stronger statement, and the copy that head already shipped
(`ProposalQuickView.tsx:69`). No new key.

## 5. §5 · The sections a proposal cannot fill — SUPPRESS or EMPTY-STATE, stated per section

The card asks for a decision in words, per section. **Every one is SUPPRESS**, with one REPLACEMENT and
one split, and the reason has the same shape each time: an empty state is a promise that the thing
could arrive, and here it cannot.

| section                       | `add`                        | `modify` / `remove`                   | why                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Development / delivery**    | SUPPRESS                     | SUPPRESS                              | a proposal delivers nothing. The target's pull requests are about the card as it STANDS; rendering them here would attribute delivery to the change, and the link out (§7) is the door to them                                     |
| **Comments / activity**       | SUPPRESS                     | SUPPRESS                              | the shipped peek never renders them either. What changes is that an `add` has nowhere to defer them TO — §6's foot sentence says so once                                                                                           |
| **Children**                  | SUPPRESS                     | SUPPRESS                              | the shipped peek renders no child list. `hasChildren` exists only to pick the plan entrance's face, and that entrance is suppressed                                                                                                |
| **Readiness banner**          | SUPPRESS                     | SUPPRESS                              | it answers _can I start this?_, moot before approval. A proposal's dependency story is the canvas's arrows (Part IX), where `blockedByNodeIds` and `blockedByRemovedNodeIds` are already drawn                                     |
| **The audit line**            | REPLACED                     | REPLACED                              | §3                                                                                                                                                                                                                                 |
| **Custom fields**             | SUPPRESS                     | **RENDER** the target's, never marked | no carrier in `PlanItemProposedFields`, so an `add` has no source and no plan can ever change one. On a target they are part of _what this work item is_                                                                           |
| **`Plan / Re-plan` entrance** | SUPPRESS                     | SUPPRESS                              | it opens a planning conversation ON a work item. A proposal is already the output of one, and its target is being re-planned right now — two plans open on one card is the state this prevents                                     |
| **Every rail EDITOR**         | SUPPRESS (the VALUES render) | SUPPRESS (the VALUES render)          | proposal editing is OUT ([MOTIR-3084](motir:cmszunxc501v8i2ph8pw1qvwk), and the story's boundary). The mode reuses the read-only path the peek already takes for an actor without `work_item:edit` rather than adding a second one |
| **`Archived` notice**         | SUPPRESS                     | **RENDER**                            | a fact about the TARGET, and a reviewer approving a change to an archived card should see it before deciding                                                                                                                       |

## 6. §6 · The EXPLANATION — inline, second, and unclamped

**`Why this matters` renders INLINE in the main column, directly under `Description`**, as two sibling
sections in the same `QuickViewSectionLabel` grammar — which is what the item PAGE does and what
`ProposalQuickView` already does. `explanationSource === 'ai_draft'` puts the shipped `AI-drafted` chip
beside the label; it stays `add`-only, because `PlanItemPatch` has no `explanationSource` twin and
reporting the target's source beside a rewritten explanation would attribute the new text to whoever
wrote the old one (the field's own note in `lib/dto/planReview.ts`).

**When it is long: it scrolls, with the description, in the main column's own scroller. No clamp, no
disclosure, no `read more`.** The main column is already `overflow-y-auto` (measured: 933 of content in
a 613 track on the shipped peek). A clamp needs a destination for the rest, and for an `add` there is
none — **deferring to a thing that does not exist is exactly how `explanationMd` came to be carried,
diffed and materialized while nothing displayed it** (MOTIR-4134). A clamp would be that defect at a
smaller scale.

**The shipped foot line is REPLACED, not kept.** `/items` ends its main column with _"Explanation,
relationships, attachments, and the activity feed live on the full page"_ — wrong twice over in this
mode: the explanation is right here, and an `add` has no full page. Proposal mode ends with:

| op                          | the line                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------- |
| **`add`**                   | `A proposal has no comments, children or activity until it is approved.` — no link |
| **`modify`** / **`remove`** | the same sentence, with `activity` linking the TARGET's full page                  |

## 7. §7 · `Open full page →`, and the ONE close

**`Open full page →` is ABSENT for an un-materialized `add`** — there is no route, and a control that
navigates nowhere is worse than no control. **It is PRESENT for a `modify` / `remove`**: the target has
a page, and it is the only way to reach the delivery, comments and children this mode suppresses. Both
are drawn.

### ⚠️ AMENDED 2026-09-02 — WHAT IT OPENS, which the first draft of this section did not say

**It opens `/items/<key>` in a NEW TAB, and that page shows the card AS IT STANDS.** Two facts,
both read off shipped code rather than assumed:

- `OpenFullPageLink` is `target="_blank" rel="noopener noreferrer"`
  (`IssueQuickViewPanel.tsx:111-124`), so the peek is not dismissed — the proposal stays open behind
  the new tab.
- **The work-item detail page has no pending-plan affordance of any kind.** `ArchivedBanner`,
  `CoreFieldsPanel`, `RelationshipsPanel`, `ChildPanel` and the late sections read no plan; nothing
  on that page knows a proposal exists.

**So the reviewer crosses a seam this story exists to close.** The peek says
`PRIORITY · changed · ↑↑ Highest`; one click later the page says `↑ High`. On a rename it is sharper
still — since [MOTIR-4018](motir:cmtgaukgt0002hwn8b22q8jsg) the peek's headline is the title the plan
PROPOSES, so the two tabs carry two different names for one card, with nothing connecting them.
**That is _one card described two different ways_, reappearing one click out of the surface that was
built to stop it.**

**The decision: KEEP the control, and CHANGE ITS LABEL so the tense is honest.** In proposal mode it
reads **`Open the work item as it stands →`** (`planReview.openTargetAsItStands`), not `Open full page`.

| candidate                                                  | verdict                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SUPPRESS it on a `modify` / `remove` too**               | **Rejected.** Proposal mode suppresses Development / delivery, comments, children and readiness (§5), and on a real target those are decision-relevant — a `remove` of a card with an open pull request is a different decision. The link is the ONLY door; removing it makes proposal mode a dead end on a card that has a page |
| **Keep it and re-label it** ✅                             | The smallest change that stops the surface asserting something false. The peek's question is _what will this BE_; the destination answers _what it IS_, and the label now says which. One copy key, no new surface, no new read                                                                                                  |
| **Keep it and put a pending-plan banner on the item page** | **Right, and OUT of this story** — the boundary ENDS AT what the reviewer reads on the review surface. It is also a new read on every item-page render. Filed as [MOTIR-4197](motir:cmtkk86cq0001hvphojbe053t) rather than deferred to this paragraph                                                                            |

**The label change is the whole of what this asset owes**, and it is deliberately not more: a
re-labelled control tells the truth about where it goes, and the banner is what would make the
destination itself agree. The two are independent, and the second is somebody else's card.

**An `add` that HAS materialized is not this surface at all.** `PlanReviewCanvas.onView` already routes
it to the committed peek (MOTIR-3161), because the proposal has become a card and carries a real
identifier. That branch is UNCHANGED, and it is the one `op === 'add'` test that survives the collapse.

**ONE close affordance, inherited rather than re-litigated.** The host passes `hideClose` to the
`Modal` and keeps the header's `QuickViewCloseButton` — Part XIII §7's decision, taken after
[MOTIR-4022](motir:cmtgaukpn0006hwn86ttsr1mu) measured two controls named `Close` 40px apart in one
dialog. `IssueQuickView`, `WorkItemQuickView` and `AttachmentPreview` all already do it.

## 8. §8 · The `remove` arm — what a card the plan will ARCHIVE looks like

The op no other panel reaches on its own, and the one the shipped surface says least about: rendered
today it is **2 rail rows, no status, no strike, and nothing anywhere that says approving archives the
card**.

| element      | treatment                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity     | the TARGET's — kind glyph, key (linked), title                                                                                                                       |
| the title    | the shipped `line-through` the list row already applies to a `remove` (`PlanProposalList.tsx:232`), so the two surfaces mark the same card the same way              |
| op chip      | `remove`, `Pill tone="archived"` — `--el-archived-pill-bg` / `--el-archived-pill-text`, the dedicated pair, because archived is an inactive state and not a severity |
| status pill  | the target's live status — a `remove` of an `In Review` card is a different decision from a `remove` of a `To Do` one                                                |
| bodies       | the TARGET's. A `remove` carries no patch, so what is shown is exactly what will be archived                                                                         |
| rail         | the target's, with **no marker on any row, ever** — a `remove` changes no field                                                                                      |
| foot line    | `Approving this plan archives {key}.`                                                                                                                                |
| the link out | present, labelled `Open the work item as it stands →` (§7)                                                                                                           |

**`targetMissing`.** A `remove` whose target is ~~already archived or~~ hard-deleted (the DTO's own
flag) shows the peek's shipped NOT-FOUND panel rather than an empty proposal — the state
`IssueQuickViewPanel state="notfound"` already draws, reused rather than re-invented.

> **⚠️ CORRECTED 2026-09-03 (MOTIR-4256) — the ARCHIVED half of that sentence was wrong.**
> `planReviewService` computes `targetMissing = item.op !== 'add' && !target`, and the batched read
> behind `target` is `workItemRepository.findByIdsInWorkspace` — a plain
> `findMany({ where: { id: { in: ids }, workspaceId } })` that does **not** filter `archivedAt`. So an
> archived target IS resolved, `targetMissing` stays `false`, and the peek renders the `remove`
> normally; only a hard-DELETED target reaches the NOT-FOUND panel. Nothing about the drawn state
> changes and no asset is re-exported — what changes is which cards reach it. It matters one surface
> over: `design/work-items/design-notes.md` § _The PENDING-PLAN indicator on the item page_ draws the
> archived-item-plus-`remove`-proposal STACK, and that panel is only real because an archived target
> keeps its proposal readable.

## 9. §9 · The two ENTRANCES — unchanged in shape, re-pointed in target

| door                                                                                                                                                  | today                                                                                     | after                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| the plan **list row** (`PlanProposalList.tsx:305-313`) — the title `<button>` with the stretched `::after`, `aria-label` `Open {name}` (Part XIII §7) | `ProposalQuickView`, on every op                                                          | the shipped peek in proposal mode                                                                            |
| the canvas **View** pill (`PlanReviewCanvas.tsx:226-240`) — the node's one control (Part V §3)                                                        | `ProposalQuickView` for an un-materialized `add`; `WorkItemQuickView` for everything else | the shipped peek in proposal mode for every proposal; `WorkItemQuickView` still for a COMMITTED sibling node |

**Neither row nor node moves.** Part IX drew the node and Part XIII drew the row; this story adds a
reading without moving one, which is the boundary the story states in its own words.

**Both doors now hold the SAME compound state.** `PlanProposalList`'s mount comment records the
assumption this Part removes — _"the canvas's peek state is a compound one — a proposal OR a committed
key — of which a list row can only ever be the first"_ — which was true and stops being true here: a
list row can still only ever open a proposal, but a proposal is now peeked through the same component a
committed key is.

## 10. §10 · Copy — every string this Part introduces or re-points

| key                                                    | string                                                                               | note                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `planReview.railChangedMark`                           | `changed`                                                                            | NEW — the rail marker chip                                                                                               |
| `planReview.railChangeCount`                           | `This plan changes {n} of the {m} fields it can set.`                                | NEW — the pinned line, `modify`, n > 0                                                                                   |
| `planReview.railChangeNone`                            | `This plan changes none of these fields — only the description and the explanation.` | NEW — `modify`, n = 0                                                                                                    |
| `planReview.railAddAll`                                | `Every value here is what approval will create.`                                     | NEW — `add`                                                                                                              |
| `planReview.railRemoveArchives`                        | `Approving this plan archives {key}.`                                                | NEW — `remove`                                                                                                           |
| `planReview.openTargetAsItStands`                      | `Open the work item as it stands`                                                    | NEW — the link out, on a `modify` / `remove`; it REPLACES `issueViews.openFullPage` in proposal mode and only there (§7) |
| `planReview.peekNoActivity`                            | `A proposal has no comments, children or activity until it is approved.`             | NEW — the main column's foot sentence (the `<link>` arm carries the `modify` / `remove` variant)                         |
| `planReview.newItem`                                   | `New`                                                                                | REUSED — the header's identifier slot                                                                                    |
| `planReview.notYetCreated`                             | `not yet created`                                                                    | REUSED — the `add` op chip                                                                                               |
| `planReview.opModify` / `opRemove`                     | `change` / `remove`                                                                  | REUSED — the op chip                                                                                                     |
| `planReview.aiDrafted`                                 | `AI-drafted`                                                                         | REUSED — beside `Why this matters`                                                                                       |
| `planReview.sectionDescription` / `sectionExplanation` | `Description` / `Why this matters`                                                   | REUSED                                                                                                                   |

**⚠️ THE NOUN IS `work item`, AND THIS SECTION IS WHERE THAT IS ENFORCED.** A mock is not a sketch —
its rendered strings are the copy a code card transcribes into the catalog, so the planner's shorthand
ships verbatim unless it is translated HERE. Motir's user-facing noun for a tracked unit is
**work item**, never `card` and never `issue`: `issueViews` says it 30 times
(`This work item isn't available`, `Child work items`, `Back to work items`), and the shipped catalog
carries `card` only in the PAYMENT sense. `planReview`'s own `item` / `proposed item` is a different
referent — a PROPOSAL, not the work item it is about — and stays as it is.

**This was got wrong in this asset's first draft** (the label read `Open the card as it stands`) and
corrected on Yue's reading. It is recorded rather than quietly fixed because the failure is invisible
locally: whoever writes the mock has just read a corpus that says `card` on every page, so the word
looks like the product's word, and whoever builds to the mock is instructed to render its strings
verbatim. **Read the mock's VISIBLE text — strip the markup — and ask of every occurrence of the
working vocabulary whether a user would read it.**

Both catalogs (`messages/en.json`, `messages/zh.json`) in the same change — a key added to one is a
parity failure.

## 11. §11 · a11y

- **The op chip carries TEXT**, never colour alone; so does the `changed` marker. Nothing on this
  surface is distinguished by hue.
- **The `changed` marker lives INSIDE the `<dt>`**, so it is announced as part of the row's own term —
  _Priority changed_ — rather than as a loose chip a reader associates by position.
- **The dialog is labelled by the proposal's title** (`Modal srTitle`), as both peeks already are.
- **ONE control named `Close`** (§7).
- **The link out is ABSENT rather than disabled on an `add`** — a disabled control in a dialog is
  a tab stop that answers nothing.
- The pinned foot line is a `<p>` in the rail column, outside the `<dl>` — so it is not announced as a
  term/definition pair, which it is not.
- The rail's `Show more fields (N)` disclosure keeps its shipped `aria-expanded`; proposal mode adds no
  control of its own.

## 12. §12 · Access path

`Plans` (left nav, Part I §5) → a row on the tabbed list (Part VII) → the plan detail (Part VIII) →
either body: the LIST's row title, or the CANVAS's `View` pill on a selected node (§9). This Part adds
no route, no nav entry and no new modal host.

## 13. §13 · GIVES / TAKES — swept over the story SUBTREE

`grep`ped this asset for every `MOTIR-<n>` it names and read the result against MOTIR-4181's children:

| key                                        | gives / takes                                                                                                                                                     | action                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **MOTIR-4183** (the projection)            | **GIVES** §2 — the merge table, the closed row set, and the marked-field set beside the payload; **and §3's denominator**, which is computed rather than constant | none; its criteria already ask for the projection and the CHANGED set |
| **MOTIR-4184** (the panel's proposal mode) | **GIVES** §3–§8 — the header, the marker, the PINNED line, the inline explanation, every suppression, the RE-LABELLED link out, and its absence on an `add`       | none; its criteria already name all four                              |
| **MOTIR-4185** (both doors)                | **GIVES** §9 — and CONFIRMS its boundary: neither door's look changes                                                                                             | none                                                                  |
| **MOTIR-4186** (the vitest gate)           | **GIVES** §2's per-op table as the thing to derive assertions FROM, and §3's `n of m` as a computed value worth a test                                            | none                                                                  |
| **MOTIR-4187** (the E2E)                   | **GIVES** the story's four verification reads a drawn expectation per op                                                                                          | none                                                                  |
| MOTIR-3084 / Part V §3                     | neither — this composes that decision and reverses none of it                                                                                                     | none                                                                  |
| MOTIR-4022 / Part XIII §7                  | neither — §7 inherits the ONE-close decision verbatim                                                                                                             | none                                                                  |
| MOTIR-4134 / MOTIR-4143                    | neither — cited as the defects whose shared cause §0 measures                                                                                                     | none                                                                  |
| MOTIR-3510                                 | neither — cited for the height-bound rule §3 and §6 apply                                                                                                         | none                                                                  |

**Nothing is TAKEN from any card in the subtree.** One scope statement WIDENS rather than narrows: §2's
merge asks MOTIR-4183 for the target's `QuickViewData` as the base on a `modify` / `remove`, where that
card's own wording (_"project into the payload the shipped quick view reads"_) is satisfied by either
reading. It is recorded here as a decision rather than left for the build to pick, and it costs no new
criterion — the read it needs is `GET /api/work-items/peek`'s own, already shipped.

**And one thing this Part ADDS to MOTIR-4184 that its criteria do not name: the rail column stops being
a bare `<dl>`.** §3's pinned line needs a flex column holding a scrolling `<dl>` plus a `<p>`. That is a
change to `QuickViewRail`'s shape, so it is either a prop on the shared chrome or a local composition —
a build decision, but not a silent one, and it is why it is written down here.

## 14. §14 · What Part XIV does NOT draw

The canvas node and the list row (Parts IX and XIII); the review rail and the Approve / Decline gate
(Part XIII §8); the revision affordance (Part XII); any editing affordance anywhere; and a full old→new
DIFF inside the peek — `changes[]` spells old→new in the list row and that is where a diff belongs
(MOTIR-4134's boundary, unchanged). **The peek's question stays _what will this work item BE_.**

> **⚠️ AMENDED 2026-09-04 (MOTIR-4493) — the DECIDED axis is now DRAWN, in §16, and the shape of this
> amendment is worth a sentence because the list did not shrink.** What a `modify` / `remove` peek
> says once the plan is `approved` or `declined` was never on this list, which is the defect rather
> than an omission from it: §15's harness seeds through `markPlanned`, so no state the asset measured
> could have exhibited a decided one, and an omission with no state in the fixture leaves nothing here
> to find. So the entry does not LEAVE the list — **it is added and immediately discharged**, with its
> address, because a reader checking this list for the decided axis must land somewhere other than
> silence. **The peek's question is now _what will this work item BE_ on an undecided plan and _what
> did this plan DO to it_ on a decided one** (§16.1), and §16.9 carries §16's own does-NOT-draw list.

## 15. §15 · How this asset was produced (reproduced here, because the harness is deleted)

The mock's stylesheet IS Tailwind's real output for this document, and its markup is composed in the
app's own utility classes against the dumped markup of the shipped components. **No token is declared
locally.**

```js
// .scratch4182/input.css  →  postcss  →  inlined verbatim into the mock's <style>
//   @import 'tailwindcss' source(none);
//   @source '../design/ai-planning/peek-proposal-mode.mock.html';
//   @import '@motir/design-system/theme.css';
postcss([tailwindcssPostcss]).process(css, { from: inputPath });
```

```ts
// a throwaway Playwright spec under tests/e2e/, deleted before the commit, driven against
// `next build && next start` on the sandbox Postgres, seeded through the SHIPPED services:
//   workItemsService.createWorkItem  — one epic, one story with a long descriptionMd, one story
//   plansService.createPlan + addProposals + markPlanned — one `add` (full proposedFields,
//     long descriptionMd + explanationMd), one `modify` (patch: title, both bodies, priority,
//     storyPoints) on the first story, one `remove` on the second
// then, at 1440x900:
//   /items?peek=<key>              → outerHTML + getBoundingClientRect/scrollHeight of the dialog,
//                                    its header, its main column and its rail; the rail's <dt> list
//   /plans/<id>?view=list          → the list body's outerHTML, then each row opened in turn for
//                                    the `add`, the `modify` and the `remove` peeks
//   /plans/<id>?view=canvas        → the node's outerHTML
```

Measurement at `deviceScaleFactor: 1`; the PNG is exported with the shipped
`node scripts/render-design-mock.mjs --width 1240 design/ai-planning/peek-proposal-mode.mock.html`,
**after** `prettier --write` on the mock. The dark panel was rendered in Chromium at
`data-theme="dark"` with `data-appearance-scope`, not inferred — a bare nested `data-theme` re-skins
nothing, because `--el-*` resolves at the element that DECLARES it.

## 16. §16 · The DECIDED axis — what a `modify` / `remove` peek says once the plan is approved or declined (MOTIR-4493)

**AMENDS this Part; it is not a new one.** Part XIV drew proposal mode across the `op` axis and never
across the DECIDED one, and §15 is why: its harness seeds through
`plansService.createPlan + addProposals + markPlanned`, so every panel above was measured on a
**`planned`** plan. An omission with no state in the fixture leaves no trace in the output — which is
why §14's own _does NOT draw_ list does not name it either. The one decided-state sentence this Part
carries is the materialized-`add` clause at §7, which answers the `add` arm and nothing else.

### 16.0 What was RENDERED first, and the one measurement that decides the section

Per the design-against-shipped-reality rule, and §0's format. The **real shipped components** were
mounted at `origin/main` `da4c407` — `PlanProposalList`, `PlanReviewCanvas`, `PlanItemNode` and
`ProposalPeek` with the real catalog, through the shipped `renderWithIntl` harness — with the plan's
decidedness varied and NOTHING else. Both doors, three plan statuses, three ops. The harness is
reproduced in §16.11 rather than cited, because it is deleted before this asset lands.

| what was rendered                                                          | what it settled                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| the same `modify`, at `planned` / `approved` / `declined`, from BOTH doors | the peek's `outerHTML` is **11,676 bytes and byte-for-byte IDENTICAL in all six**                                                                |
| the same `remove`, same six                                                | identical again — and its peek renders the shipped **`Archived` banner and pill** over a foot line reading `Approving this plan archives RND-3.` |
| a DECLINED `add` through the list door                                     | it does **not** route away — `identifier` is null for ever, so it opens proposal mode and reads `Every value here is what approval will create.` |
| the list ROW beside the peek it opens, on an approved plan                 | row `Applied` · `applied`; peek `change`. Eight lines apart in one component tree                                                                |
| the CANVAS node beside the peek its `View` pill opens                      | node `change · declined`; peek `change`                                                                                                          |

**The load-bearing number is the first one, and it is stronger than the report this card was carved
out of.** MOTIR-4472 says the peek speaks in the future tense after a decision. It does not merely
speak in the wrong tense — **it cannot tell**: the plan's status reaches `PlanDetail`, forks into a
`decided` boolean for the list and a three-valued `outcome` for the canvas, and reaches `ProposalPeek`
**not at all** (`ProposalPeek({ item, onClose })`, §7's own signature). A surface whose output does not
change when its subject does is not stale; it is blind, and no amount of re-wording fixes a component
that was never told.

**And it is why the approved-`remove` panel is the sharpest evidence in the asset**: the shipped
`ArchivedBanner` says _This work item is archived_ and the rail foot, 500px below it in the same
dialog, says _Approving this plan archives RND-3._ Both are rendered from the same open. One of them
is reading the target's payload, which knows; the other is reading the proposal envelope, which does
not.

### 16.1 The DECISION — **(b)**, and the axis is THREE-VALUED rather than a boolean

**Proposal mode GAINS a decided arm. The peek is not routed away.** The two candidate answers this
card was handed:

- **(a)** route a decided plan's every row to the ordinary work-item peek, as the materialized-`add`
  arm already does (§7's `:4001` clause / `PlanReviewCanvas.onView`);
- **(b)** give proposal mode a decided arm — the same surface, in the past tense.

**(b), and this asset sharpens its shape:** the peek takes the plan's **OUTCOME**
(`'accepted' | 'declined' | null`), the value `PlanDetail` already computes for the canvas — never a
`decided` boolean. Part VI §3 settled the arithmetic and this Part inherits it rather than re-deciding
it: `op` and `outcome` are independent, so there are **six** renderings and not four, and a two-valued
prop has to pick one decided arm as the default for both. (The list picked the approve arm and is
wrong on every declined plan — measured above, filed as **MOTIR-4495**, and NOT this card's to fix.)

### 16.2 Why not (a) — four reasons, and the fourth is the one that generalises

1. **This area has answered this exact question twice, and both times it KEPT the surface and moved
   the TENSE.** Part VI §4 re-decided the canvas pane on the ground that after a decision it holds
   **the record of the decision** — _"A record is not spent by the decision — it is produced by
   it."_ Part VIII §3 gave the list `Created` / `Applied` / `Archived` rather than removing it. (a)
   would be the first time this surface answers a decision by DELETING a reading, and it would do it
   on the one component whose stated purpose (§3) is to record which fields the plan moved.
2. **Part VI §3 already ruled on a future-tense signal left standing on a decided proposal, and the
   remedy was ADDITION.** Its declined-`remove` clause: _"The strike is the one place a reader could
   be misled — it says will be archived about a work item that was not. The chip's `declined` segment
   is what corrects it."_ The rail foot's `Approving this plan archives {key}.` is that same
   misleading signal, in a full sentence, on the same op.
3. **(a) is not available where the record matters most.** A DECLINED `modify` routed to the ordinary
   peek shows a work item with nothing anywhere saying a plan proposed to change it and was refused —
   the record is not diminished, it is gone, and the plan row is then the only place it survives. An
   approved `remove` whose target was hard-deleted routes to a **404**.
4. **§7's `add` clause does NOT generalise, and reading it as a decidedness rule is the mistake this
   section exists to name.** A materialized `add` routes away because **the proposal BECAME the work
   item** — projection and work item are one object, so the proposal reading holds nothing the
   committed reading lacks. A `modify` is the opposite shape: the proposal is a **DELTA** and the work
   item is the **RESULT**, and the work item as it stands cannot say which fields this plan moved.
   **The routing is a consequence of IDENTITY, not of decidedness** — which is also why it correctly
   does not fire on a DECLINED `add`, whose `identifier` stays null for ever (§16.0, measured).

### 16.3 The op chip — Part VI §3's FUSED chip, one primitive over

The peek's status slot (§4) carries the op chip, and on a `modify` / `remove` the target's live
`StatusValue` beside it. **Decided, the op chip gains a second SEGMENT carrying the outcome word**, so
it reads `op × outcome` — exactly the construction `PlanItemNode`'s `OpBadge` already draws
(`:192-250`), which is the node the canvas's `View` pill sits on.

| slot                    | `planned`         | `approved`                | `declined`                         |
| ----------------------- | ----------------- | ------------------------- | ---------------------------------- |
| `modify`                | `change`          | `change` · **`accepted`** | `change` · **`declined`**          |
| `remove`                | `remove`          | `remove` · **`accepted`** | `remove` · **`declined`**          |
| `add` (un-materialized) | `not yet created` | — routes away (§7)        | `not yet created` · **`declined`** |

- **Segment 1 is the shipped chip, byte for byte** — `Pill severity="info"` / `status="planned"` /
  `tone="archived"` (§4, unchanged). **Segment 2** takes Part VI §3's own two pairs:
  accepted `bg-(--el-tint-mint)` / `text-(--el-text-strong)`, declined `bg-(--el-muted)` /
  `text-(--el-text-secondary)`. The seam is a 1px `border-s border-(--el-border-soft)` rule, not a gap;
  `--radius-badge` on the outer corners, `--spacing-chip-x/y` per segment.
- **The peek's op chip is a `Pill` and the node's is a bare span, and NEITHER changes its primitive.**
  The construction is shared, the primitive is each host's own — the same relationship §4 already has
  with `PlanProposalList.tsx:90-92`.
- **NO NEW COPY KEY.** `planReview.opModify` / `opRemove` / `notYetCreated` and
  `planReview.outcomeAccepted` / `outcomeDeclined` all ship, the last two authored by Part VI for this
  exact word. **No fourth vocabulary**, which is §4's own rule applied to a second axis.
- **Why the chip and not the LIST's `applied` / `archived` word.** They answer different questions:
  Part VI's `accepted` / `declined` is what happened to the **PROPOSAL**, Part VIII's `created` /
  `applied` / `archived` is what happened to the **WORK ITEM** — and the peek's status slot is where
  _the proposal's own state lives_ (§4, in those words), with the work item's own state already
  rendering beside it as the `StatusValue` and the `Archived` pill. Saying `archived` in the op slot of
  a dialog that already carries an `Archived` pill would be the surface saying one thing twice and the
  other thing not at all.

### 16.4 The primary control's label — the override **LIFTS** on approved, and **STAYS** on declined

§7 decided that proposal mode re-labels the link out to **`Open the work item as it stands →`**
(`planReview.openTargetAsItStands`), and it says why in its own words: the destination shows the work
item as it IS, so the peek's `changed · Highest` and the page's `High` are one work item described two
ways. **That label is a WARNING about a divergence, so it is right exactly while the divergence
exists.**

| plan status    | the control reads                   | key                                                |
| -------------- | ----------------------------------- | -------------------------------------------------- |
| `planned`      | `Open the work item as it stands →` | `planReview.openTargetAsItStands` (unchanged)      |
| **`approved`** | **`Open full page →`**              | **`issueViews.openFullPage` — the override LIFTS** |
| **`declined`** | `Open the work item as it stands →` | `planReview.openTargetAsItStands` (kept)           |

- **Approved: the divergence is gone, so the warning is spent.** The plan has been applied; the
  destination IS the projection. §7 says `openTargetAsItStands` _"REPLACES `issueViews.openFullPage`
  in proposal mode and only there"_ — and once the two agree, "only there" has stopped being here.
  Keeping it would assert a disagreement that no longer exists, which is the same class of untruth
  §7 introduced it to remove.
- **Declined: the divergence is MAXIMAL, and this is the state the label was written for.** The peek
  shows what the plan proposed; the page shows the work item, untouched. A reader who follows the link
  finds none of it.
- **A REUSED key, not a new one**, and the pleasing result is that the label retires on the state it
  was drawn against and survives on the state nobody had drawn.
- **On an `add` the control is ABSENT at every status** (§7) — a declined `add` has no route, and it
  never will have one.

### 16.5 The rail-foot line — the four arms become nine, and SIX new keys

§3's pinned line is the sentence that reads the silence of the unmarked rows, and it is the only
element on the surface that states what the plan DOES. It is therefore the whole of the tense.

| op                  | `planned` (ships)                                                                                        | `approved`                                                                                                              | `declined`                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **`add`**           | `Every value here is what approval will create.`<br>`railAddAll`                                         | — routes away (§7)                                                                                                      | **`This plan was declined — none of these values was created.`**<br>**`railAddDeclined`**                                                     |
| **`modify`**, n > 0 | `This plan changes {n} of the {m} fields it can set.`<br>`railChangeCount`                               | **`This plan changed {n} of the {m} fields it can set.`**<br>**`railChangeCountApplied`**                               | **`This plan would have changed {n} of the {m} fields it can set. It was declined, so none of them moved.`**<br>**`railChangeCountDeclined`** |
| **`modify`**, n = 0 | `This plan changes none of these fields — only the description and the explanation.`<br>`railChangeNone` | **`This plan changed none of these fields — only the description and the explanation.`**<br>**`railChangeNoneApplied`** | **`This plan would have changed none of these fields — only the description and the explanation.`**<br>**`railChangeNoneDeclined`**           |
| **`remove`**        | `Approving this plan archives {key}.`<br>`railRemoveArchives`                                            | **`This plan archived {key}.`**<br>**`railRemoveArchived`**                                                             | **`This plan would have archived {key}. It was declined, so it was not.`**<br>**`railRemoveDeclined`**                                        |

**Six new keys, in `planReview`, in BOTH catalogs — `messages/en.json` and `messages/zh.json` in the
same change, because a key added to one is a parity failure** (§10's rule, unchanged).

Four decisions inside that table, each of which could have gone the other way:

- **The COUNT survives on `declined`, and that is the whole of what (b) buys.** The cheap declined
  arm is one flat sentence — _"This plan was declined."_ — which drops `n of m`. But the CHANGED
  markers are still on the rows, and §3's entire argument is that a marker without the denominator
  cannot be read: an unmarked row means either _the plan is not changing this_ or _no plan can change
  this at all_. Dropping the count on declined would keep every marker and delete the line that makes
  them legible, which is the ambiguity §3 exists to remove, restored one state over.
- **`would have` rather than a bare past.** A declined `modify` did not change two fields and did not
  change none of them; it proposed two and was refused. The subjunctive is what carries that, and it is
  the same tense Part VI's `declined` segment puts on the node.
- **The declined arms NAME the decline** rather than leaving it to the chip. Colour is never the only
  carrier (§11) and neither is a chip 500px above the line: the sentence at the foot of the rail is
  read by somebody who has scrolled the rail, and it has to stand on its own.
- **`remove` × approved reads `This plan archived {key}.`, not `{key} is archived`.** The `Archived`
  pill and the shipped `ArchivedBanner` already say the work item IS archived; what only this line can
  say is **who did it** — this plan. That is the whole reason (a) is wrong for this cell, in one
  sentence.

> **⚠️ AMENDMENT (MOTIR-6119) — the `modify`, n = 0 row NAMES the fields it moves.** The three cells
> above ended in a fixed _"only the description and the explanation"_, which is false for a plan that
> renames a card (the title moved) or edits only the explanation. The line now reads the SAME
> `changedFields` set the main column's markers read, minus the settable rail rows: `railChangeNone*`
> ends _"— only {fields}."_ (`{fields}` is the changed main-column fields' `planReview.field_*` labels,
> as a locale-aware list — _title and description_ / _标题和描述_), and a `modify` that moves no field
> at all reads the new `railChangeNothing*` keys — _"This plan changes none of these fields."_ — in the
> same three tenses. Both catalogs, as ever.

### 16.6 The DECIDED axis, cell by cell

The axis is an enum and the enum is the checklist. Every cell is DRAWN or is named here with its
reason.

| plan status    | `modify`             | `remove`                                                 | `add`                                                          |
| -------------- | -------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| **`planned`**  | unchanged — §§2–8    | unchanged                                                | unchanged                                                      |
| **`approved`** | **DRAWN** — panel 10 | **DRAWN** — panel 10, incl. the `Archived` banner + pill | **NOT DRAWN**: routes to the committed peek (§7), MOTIR-4471's |
| **`declined`** | **DRAWN** — panel 10 | **DRAWN** — panel 10                                     | **DRAWN** — panel 10; see the correction below                 |

> **⚠️ CORRECTION — MOTIR-4493's own brief was wrong about one cell, and the render is what found
> it.** The card assigned BOTH decided `add` cells to MOTIR-4471 (_"already answered at `:4001`"_).
> That is true of `approved` and **false of `declined`**: §7's clause and
> `PlanReviewCanvas.onView` / `PlanProposalList.openPeek` alike key on
> `op === 'add' && identifier != null`, and a declined `add` keeps `identifier: null` **for ever** —
> Part VI §3 says so in its own words (_"A declined `add` keeps `new`, and must: it never became
> anything"_). Rendered, a declined `add` opens proposal mode and reads
> `Every value here is what approval will create.` about a plan that can never be approved. The cell
> is drawn here and `railAddDeclined` is its copy. Amended on MOTIR-4493's record.

**Two sub-cells, drawn as limits rather than as panels:**

- **`remove` × decided × `targetMissing`** (hard-deleted target) — **UNCHANGED**: the shipped
  not-found panel, `IssueQuickViewPanel state="notfound"` (§8, and the 2026-09-03 correction that
  narrowed it to hard-deleted only). It is a deliberate limit, not an oversight: proposal mode's
  decided arm speaks about a target it can READ, and a target that no longer exists leaves the plan's
  own row as the only surviving record — which the LIST still has (Part VIII §3). Giving the not-found
  panel a decided arm would mean drawing the plan's record inside a panel whose whole message is that
  there is nothing to show.
- **`modify` / `remove` × decided × the CHANGED markers** — **UNCHANGED**, on every marked row. They
  are the record. This is the single element (a) would have discarded, and keeping it is what §16.5's
  denominator is for.

### 16.7 Both doors, on a decided plan

MOTIR-4185's property — the list row and the canvas `View` pill open the **same** peek — **holds
unchanged, and was re-measured at both decided values** (§16.0: the six `modify` renderings are
byte-identical across both doors as well as across all three statuses). §9's table needs no new row:
the two doors are unchanged in shape and unchanged in target, and the decided arm is a property of the
peek rather than of either door. Panel 10 draws both, on a decided plan, so a reader can see it is
still true.

**What this section does NOT touch on either door**: the list row's own vocabulary and the canvas
node's own outcome chip are Part VIII §3's and Part VI §3's respectively. **The list's declined arm is
a shipped DEFECT** — measured in §16.0, filed as **MOTIR-4495** — and it is named here only because a
reader comparing the row to the peek on a declined plan will see two wrong things and should know
which card owns which.

### 16.8 a11y

- **The outcome segment carries TEXT** — `accepted` / `declined` — inside the chip, exactly as Part VI
  §3 requires. Nothing on this surface is distinguished by hue, and the decided axis adds no exception.
- **The foot line NAMES the decline in words**, so a reader who never reaches the chip still gets it.
- The chip stays ONE tab-stop-free `<span>` pair; the decided arm adds **no control**, so §11's
  count of one `Close` and one link out is unchanged.
- The re-labelled link out (§16.4) changes its accessible name with its visible text, which is the
  shipped `Link`'s behaviour — the label IS the accessible name here.

### 16.9 What §16 does NOT draw

The list row and the canvas node on a decided plan (Part VIII §3 and Part VI §3 — composed here by
citation, never re-specified); the review rail's `DecidedOutcome` and the Approve / Decline gate (Part
VI §1 and Part XIII §8); the establish band an approve stacks above the canvas (Part VI §4); the
decided arm of the not-found panel (§16.6, named as a limit); and any change to WHICH proposal a door
routes where — §7's identity rule is composed, not re-decided.

### 16.10 GIVES / TAKES — swept over every `MOTIR-<n>` this section names

`grep`ped the finished asset for every key it names and read each against the tree.

| key                                                                         | element / structure / premise                                                                                                                                                                                                                                                           | gives / takes                                       | action                                                                                                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4472** (the peek's decided arm)                                     | **ELEMENT** — the fused chip, the label rule, six copy keys with their strings; **STRUCTURE** — the peek takes an OUTCOME, not a boolean, so the prop is three-valued; **PREMISE** — its own body offered (a) and (b) and recommended (b): (b) is confirmed, and its shape is corrected | **GIVES**                                           | **RE-ESTIMATED — see below**                                                                                                                                                       |
| **MOTIR-4471** (the `add` arm)                                              | **PREMISE** — §16.2(4) restates its routing rule as a consequence of IDENTITY rather than of decidedness, which is what its own fix already keys on (`identifier != null`); **TAKES** — its scope does NOT extend to a DECLINED `add`, which the brief had assigned to it               | **TAKES** (a scope it was never asked for)          | **none owed** — nothing in MOTIR-4471's criteria claims the declined `add`; it is `implemented` on exactly the materialized arm. Recorded so the next reader does not re-assign it |
| **MOTIR-4495** (the list's boolean)                                         | **PREMISE** — §16.1's three-valued argument is the same one, one component over                                                                                                                                                                                                         | neither — filed by this pass, with its own criteria | none                                                                                                                                                                               |
| **MOTIR-4185** (both doors)                                                 | **PREMISE** — its property is re-measured at both decided values and holds                                                                                                                                                                                                              | neither                                             | none — `done`, and confirmed rather than changed                                                                                                                                   |
| MOTIR-3161 / Part VI §3                                                     | **PREMISE** — the `op × outcome` arithmetic and the two colour pairs are borrowed verbatim                                                                                                                                                                                              | neither                                             | none                                                                                                                                                                               |
| MOTIR-3239 / Part VIII §3                                                   | **PREMISE** — the decided list's tense rule, cited; its declined half is MOTIR-4495's                                                                                                                                                                                                   | neither                                             | none                                                                                                                                                                               |
| MOTIR-4183 / MOTIR-4184                                                     | **PREMISE** — the envelope and the overlay are unchanged; the outcome rides beside them, not inside `changedFields`                                                                                                                                                                     | neither                                             | none — both `done`                                                                                                                                                                 |
| MOTIR-4197                                                                  | neither — the item page's pending-plan banner is still somebody else's card, and §16.4 does not touch it                                                                                                                                                                                | neither                                             | none                                                                                                                                                                               |
| MOTIR-3084 / MOTIR-4022 / MOTIR-4134 / MOTIR-4143 / MOTIR-4256 / MOTIR-4277 | neither — cited as history / provenance                                                                                                                                                                                                                                                 | neither                                             | none                                                                                                                                                                               |

**The one action, and it is a SIZE rather than a criterion.** MOTIR-4472 was authored at **3 points /
50 minutes** against a body that named _"three new copy keys"_. What this section hands it is a
three-valued prop threaded from `PlanDetail` through both hosts into `ProposalPeek`, a fused chip, a
conditional on WHICH label key the link out reads, **six** new keys in **two** catalogs, and a test
matrix of three statuses × three ops. That is not the card that was sized. **Re-estimated to 5 points
/ 70 minutes in this same pass** (`plan-rules/type-design.md`'s sweep-the-referrers corollary — a
GIVES that outgrows a card's sizing is re-estimated by the designer, not discovered by whoever picks
it up). It stays ONE card: one component, one repository, one pull request, and splitting a chip from
the sentence beside it would put two halves of one tense in two reviews.

### 16.11 How the decided panels were produced (reproduced here, because the harness is deleted)

The mock's stylesheet is unchanged — Tailwind's own output for this document, per §15 — and the new
panels are composed in the app's own utility classes against the **dumped markup of the shipped
components**, taken from the render below. No token is declared locally.

```ts
// a throwaway spec under tests/components/, deleted before the commit, run in the SHIPPED
// happy-dom harness (tests/helpers/renderWithIntl + tests/helpers/planReview), so the
// components are the real ones and the strings are the real catalog:
//
//   render(<PlanProposalList items={[item]} decided={d} />)          // the LIST door
//   render(<PlanReviewCanvas items={[item]} projectKey="MOTIR"
//                            version={0} outcome={o} />)             // the CANVAS door
//
// for item ∈ { modify, remove, un-materialized add }
//     × (d, o) ∈ { (false, null), (true, 'accepted'), (true, 'declined') }
//
// then, per cell: the row's outerHTML, the node's outerHTML, and — after driving the door the
// way a reader drives it (click the row title / select the node, then View) — the peek's
// outerHTML from [data-testid="proposal-peek"]. `/api/work-items/peek` is stubbed with the
// target's payload, which is the request §2's amendment says the peek makes on open.
```

**The comparison is byte-for-byte** (`diff` over the dumped `outerHTML`), which is what turns _"the
peek looks the same"_ into the 11,676-byte identity in §16.0. §15's Playwright-against-`next start`
harness would have measured the same thing more expensively: this section decides no geometry — every
panel below is a string and a chip inside a layout §3 and §4 already measured at 1440×900 — so the
render it needed was of the MARKUP, not of the pixels.

---

# Part XV — The PROPOSED to-do list in the peek's PROPOSAL MODE: the read-only steps on an un-materialized `add`, their executor marks and commands, the empty / at-scale / long-command states, and why a `modify` shows none (MOTIR-4615 / Story MOTIR-3810)

**Asset:** `peek-proposed-todos.mock.html` + `peek-proposed-todos.png`, rendered at viewport 1200,
`deviceScaleFactor: 2` (export 2400×11500).

When a plan proposes a `manual` work item, the proposal already carries that card's ORDERED STEPS
(`docs/decisions/agent-authored-plans.md` AMENDMENT 14, MOTIR-4614). Until now the reviewer read
those operations as a paragraph — the one thing they are actually approving on a `manual` card was
the one thing the surface could not show. This Part draws where they read them instead: a
**read-only To-do list** in the peek's main column, one click before Approve.

**A NEW asset, not an edit of Part XIV's.** § _A design result is a MOMENT_ (Yue, 2026-08-20):
a new element on an existing surface gets its own file. `peek-proposal-mode.mock.html` stays frozen
at what MOTIR-4182 decided.

## 15.1 Composition — what comes from where, and what is DROPPED

Nothing here is drawn twice. Both halves are shipped assets and this Part cites rather than redraws
them.

| element                            | comes from                                                 | kept / dropped                                                                 |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| the section shell + header grammar | `ContentSectionCard`, as `todo-list.mock.html` composes it | KEPT whole — the created card shows the same section, so it must look the same |
| `To-do list` + the muted gloss     | `todo-list.mock.html` § the section header                 | KEPT; the gloss reads _"the steps this card proposes"_ rather than the card's  |
| the `0 of N` count, mono           | same                                                       | KEPT — `0 of 5`, because a proposal has no ticked row                          |
| the three-track row grid           | `todo-list.mock.html` `.todoRow`                           | **DROPPED to two.** The actions track has nothing to hold                      |
| the checkbox                       | same, `.cbox`                                              | KEPT, **inert**: unchecked, `aria-disabled`, `--el-input-readonly-bg`          |
| the 13.5px plain-text step         | same                                                       | KEPT verbatim                                                                  |
| the executor pill `You` / `Agent`  | same, `.execMark`                                          | KEPT verbatim                                                                  |
| the mono command box + copy button | same, `.cmdBox` / `.cmdVal`                                | **KEPT, including copy** — copying a command is a READ                         |
| the `Instructions` disclosure      | same, `.notesToggle` / `.notesBody`                        | KEPT and still interactive — expanding notes is a read                         |
| the reorder grip / edit / delete   | same, `.rowActions`                                        | **DROPPED**                                                                    |
| the `Add a step` row               | same, `.addRow`                                            | **DROPPED**                                                                    |
| the peek chrome                    | `components/workItems/QuickViewSurface.tsx` (Part XIV)     | KEPT; re-declared as `.peek*` shims against the same tokens                    |

**Why the checkbox stays and is not simply removed.** It is what makes the section recognisable as
_the list you will tick_. Removing it would leave a bulleted paragraph that happens to sit in a card,
which is what this whole story exists to stop being the answer. It is dimmed rather than left at full
contrast because a control that looks tickable and is not is worse than no control at all.

## 15.2 Placement, measured

- **Viewport 1440×900**, peek **980×680** (Part XIV's `h-[680px]`), main column **626×613**, rail
  **300px** — Part XIV's own numbers, inherited rather than re-measured.
- The section is **the last thing in the main column**, after the explanation. The peek defers
  children and comments to a page a proposal does not have (Part XIV §2), so there is nothing below
  it, and the reader reaches it by scrolling the body they were already reading.
- **At 5 rows the column does not scroll.** At **12 rows it does** — and that is the answer to _does
  the section get its own scroller?_ **No.** It grows, and `QuickViewMain`'s existing
  `overflow-y-auto` is the one scroll surface. A second scroller inside the first gives the reader
  two things to move and no way to tell which one they are in. The 300px rail is a sibling grid cell
  and does not move.

## 15.3 The states, panel by panel

| panel | state                  | what the reader sees                                                                  |
| ----- | ---------------------- | ------------------------------------------------------------------------------------- |
| 1     | 5 steps, 1440×900      | the section at the foot of the main column, no scroll                                 |
| 2     | the row's read face    | the shipped write face beside it, so what is dropped is visible rather than described |
| 3a    | **absent**             | **no section at all** — see below                                                     |
| 3b    | 1 step                 | the header still carries `0 of 1`                                                     |
| 3c    | instructions expanded  | the disclosure opens in place; the section grows and the column scrolls               |
| 4     | 12 steps               | the column scrolls, the rail stays put                                                |
| 5     | the long command, 1440 | only the inside of the mono box moves                                                 |
| 5     | the long command, 390  | the body is one column; same containment, more of the command visible per line        |
| 6     | `modify` / `remove`    | **no list**, drawn deliberately                                                       |
| 7     | dark                   | the same markup under `data-theme="dark"`                                             |

**The ABSENT state is the one with an argument behind it.** An `add` with no `todos`, or with `[]`,
renders **nothing** — not an empty section reading `To-do list · 0 of 0`. That is Part XIV §1's rule
applied to a new row: _a row's absence is a statement about the SUBJECT_. An empty section asserts
that a planner considered this card's steps and proposed none, which is a claim the data cannot
support — the same proposal is produced by a planner that never reached the question.

## 15.4 `modify` and `remove` — drawn as NOT drawn

Panel 6 exists so that nobody adds a list there later by accident, and so the absence reads as a
decision rather than as an omission. Three facts, none of them about this design:

1. a `modify`'s target is a **committed** card, whose list is a **person's progress** — ticked rows,
   with `doneAt` and `doneById`;
2. `QuickViewData` carries **no to-do field** (`lib/dto/quickView.ts`, checked at `d2a0c964b`), so
   the peek has nothing to render even if it wanted to;
3. AMENDMENT 14 **D2** refuses a `todos` on a `modify` patch, so a plan could not change one either.

The steps are shown on an `add` — which has no live card to fetch them from, and whose steps
therefore exist nowhere else — and on nothing else.

## 15.5 ⚠️ Two things this asset had to fix in the technique, and one of them is a filed defect

Both were found by rendering the dark panel and reading it, which is the only way either surfaces.

**(a) A Tier-3 token does not re-derive in a NESTED dark scope.** A custom property's `var()` is
substituted at computed-value time on the element that DECLARES it, so `--el-text:
var(--color-foreground)` declared on `:root` computes to the LIGHT foreground and it is that value
which inherits. A descendant carrying `data-theme="dark"` flips Tier 0 for its subtree and cannot
retroactively re-substitute Tier 3. **In the real app this never arises** — `data-theme` sits on
`<html>`, the same element `:root` matches — and it arises only in a MOCK drawing a dark panel beside
a light one. This asset therefore repeats the identical `--el-*: var(--color-*)` declarations inside
`[data-theme='dark']`. **It declares no new token and no new value.**

**(b) A CSS ESCAPE BELONGS IN THE SELECTOR AND NEVER IN THE `class` ATTRIBUTE.** `todo-list.mock.html`
writes its Tailwind arbitrary-value utilities as `class="text-\[13.5px\] text-\(--el-text\)"` — with
literal backslashes in the HTML. The selector `.text-\(--el-text\)` matches the class
`text-(--el-text)`; the attribute above declares the class `text-\(--el-text\)`. **They never meet**,
so every one of those utilities is inert, and the element falls back to whatever it inherits.

In LIGHT that is `body { color: var(--el-text) }` — the right colour by accident. In a scoped dark
panel the inherited value is still the light one, so **the steps render near-black on near-black**.
It is visible in that asset's own committed PNG.

**138 such class attributes, in exactly one file, tree-wide** (`git ls-tree origin/main -- design`,
every `*.mock.html`). **Filed as a bug on story MOTIR-3810, `relates_to` MOTIR-4615.** This asset
does not inherit it: its class attributes carry no escapes, which is also what the shipped app emits
and what `peek-proposal-mode.mock.html`'s real Tailwind output already looks like.

## 15.6 Access path

**No new door.** The peek is opened from the **plan list row** (its title button, Part XIII §7) and
from the **canvas node's `View` pill** (Part V §3) — both shipped by MOTIR-4185, both drawn in Part
XIV panel 0. This Part draws neither and adds none: the steps are inside a surface the reader has
already opened.

## 15.7 GIVES / TAKES

Every `MOTIR-<n>` in the asset and in this Part, dispositioned.

| key            | GIVES / TAKES                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-4622** | **GIVES** — the review surface builds this. It owns `PlanReviewItemDto.todos` and the peek's read-only section, to this asset. |
| **MOTIR-4625** | **GIVES** — the acceptance E2E films this surface; the panels are what it should show.                                         |
| MOTIR-3810     | the story. GIVES its verification recipe the surface it names.                                                                 |
| MOTIR-4614     | the ADR amendment. **TAKES** — D1, D2 and D5 are what this asset draws; it decides none of them.                               |
| MOTIR-4182     | Part XIV. **TAKES** the peek chrome, the per-op header and §1's absence rule.                                                  |
| MOTIR-4185     | **TAKES** the two doors, unchanged.                                                                                            |
| MOTIR-3812     | the to-do design. **TAKES** the row grammar, the executor pills and the overflow rule.                                         |
| MOTIR-4181     | the peek story. **TAKES** the surface.                                                                                         |

**Nothing is TAKEN from MOTIR-4622.** This asset removes no element it was going to build and moves
no boundary: it is strictly the surface that card was already `blocked_by` this one for.

## 15.8 ⚠️ Planning flags

- **`design/work-items/todo-list.mock.html`'s class escapes (15.5b) are a DEFECT with a card**, not a
  note here. It is filed on story MOTIR-3810 and `relates_to` MOTIR-4615. It blocks nothing in this
  story: this asset is already free of it, and MOTIR-4622 builds from THIS asset. The 138 attributes
  in that one file are what the fix has to sweep.
- **No other flag.** The states this Part draws are all reachable from the shipped surface, and the
  one number it does not own — the peek's own geometry — is Part XIV's and is cited rather than
  re-measured.

---

# Part XVI — the plan-change canvases meet the "Not in an epic" group (MOTIR-4773 · `plan-canvas-grouped-roots.mock.html`)

The card this unblocks is **MOTIR-4771**, and its first five acceptance criteria are settled here.

`design/roadmap/design-notes.md` § _The ROOT level's NON-EPIC rows_ (decisions 1–7) drew a grouped
node for a canvas whose level **is** the tree. The planning workspace overlay draws the tree **with a
pending change laid over it** — that is the whole reason the surface exists — and MOTIR-4771 asks for
the grouping on that surface. Grouping is a rule about which rows LEAVE a level; the diff frame is a
rule about which rows must be SEEN. Nobody had drawn the meeting.

**Everything the roadmap decided is CITED, not re-decided**: the node's face, its name, its drill,
its `decorative` status and the truncation tile are that section's, unchanged. This Part rules only
on the composition, and on which surface gets which cap affordance.

## 16.1 Drawn against SHIPPED reality — what was RENDERED, and how

Every card on the board is the **shipped component**, rendered through the **shipped pipeline** and
lifted into the asset: a throwaway RTL dump ran `buildWorkItemLevel` and then
`decoratePlanChangeLevel` over a fabricated root level, and each node's `content` was written out as
markup. Nothing is redrawn, and the boards are positioned by the real layout constants —
`NODE_W` 280, `NODE_H` 124, `GAP_X` 80, `GAP_Y` 72, `BAND_GAP` 96, origin 40
(`lib/planning/projectCanvasModel.ts`).

That is also what makes sheet 4 EVIDENCE rather than an illustration: the duplicate card it shows was
produced by the pipeline, not drawn to make a point.

## 16.2 DECISION 1 — with NO pending proposal, the overlay groups, identically to `/roadmap`

`PlanChangeCanvas` short-circuits on an empty diff (`decoratePlanChangeLevel` returns the level
untouched when `index.isEmpty`), so in the state a reader is in every time they open the workspace
before saying anything, there is **no composition at all**. Same node, same
`roadmap.canvas.group.title` copy, same drill, same tile.

Stated and drawn (sheet 2) rather than inherited by silence, because it is the state MOTIR-4771 was
reported from and the one a reader will check first.

## 16.3 DECISION 2 — a row the pending proposal TOUCHES stays on the road

**The predicate gains a third conjunct on the plan-change canvases:**

```
parentId === null && kind !== 'epic' && !touchedByThisProposal(id)
```

The roadmap's decision 1 justifies its two conjuncts with _"the road IS the epics. This is the
level's whole subject."_ On a canvas whose subject is a PROPOSED CHANGE, the level's subject is the
epics **and what the change is about** — so this is the same rule applied to a different subject, not
a departure from it. Decision 6 of that section already added a conjunct for a surface whose meaning
differs (sprint scope); this is the third, for the same reason.

**⚠️ TOUCHED means MEMBERSHIP IN THE PROPOSAL, never `diffStateForItem`'s verdict.** A code card will
reach for `diffStateForItem` because it is the function that answers "what state is this row in", and
it would be wrong: that function returns `'locked'` for **every** terminal-status row on the level
whenever the index is non-empty, regardless of whether the plan touches it. Most parentless defects
on a mature tree are `done`, so keying on it would drag nearly the whole group back onto the road the
moment any plan is pending. The set is:

```
index.changesById.has(id) || index.removalsById.has(id) || <a materialized add whose nodeId is id>
```

`locked` is a property of the row's own status, not of the proposal, and it does not qualify.

### What the alternatives MEASURE — both were rendered, and both fail

| disposition                                                | verdict    | what the render shows                                                              |
| ---------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| **(a)** a touched row stays on the road                    | **CHOSEN** | sheet 3 — both frames on the level the reviewer is on; the group's count falls 3→1 |
| **(b)** group everything, mark the group                   | rejected   | sheet 4's failures, plus new pixels in slots the roadmap left deliberately empty   |
| **(c)** group everything, frames only on the drilled level | rejected   | sheet 4                                                                            |

**Sheet 4 is the measurement, and it has two independent failures:**

1. **The `modify` disappears from the level.** MOTIR-4771's `change` frame is not on the board at
   all — the reviewer's own subject, filed behind a drawer, on the surface that exists to review it.
2. **⚠️ AN ACCEPTED CARD IS DRAWN TWICE — this is bug MOTIR-3206, re-created by passing one
   boolean.** A materialized `add` carries the committed work item's **own id** as its `nodeId`
   (`lib/planning/planChangeDiff.ts`, `isMaterializedAdd`); `decoratePlanChangeLevel` merges the add
   frame ONTO that node and deletes the entry, and appends whatever is left as a keyless
   `ProposedAddNode`. Group the committed row away and the merge cannot land, so the entry survives
   and the card appears a second time — once inside the group, once beside it. That function's own
   comment names the defect: _"a second, keyless copy of every accepted card on the canvas"_.

**So the constraint on this decision is not a preference and is recorded as a constraint:** a
disposition that removes a proposal's target from `base.nodes` before the decoration runs re-opens
MOTIR-3206. **(a) satisfies it by construction** — the touched row never leaves the level, so the
merge fires exactly as it does today, which is what sheet 3's live `To Do` pill inside the add frame
shows.

## 16.4 DECISION 3 — the grouped node says NOTHING about its contents beyond the count

`design/roadmap`'s decision 3 leaves the status pill and the progress meter deliberately empty,
because each would be a claim about work the node does not own. **Both stay empty here, and no third
slot is added.**

Under decision 2 there is nothing for a change signal to signal: a row the proposal touches is not in
the group. A "something in here changed" badge is an affordance disposition (b) would have needed and
(a) does not — recorded so that the absence reads as a decision rather than as an oversight, which is
the same reason the roadmap section recorded its two empty slots.

## 16.5 DECISION 4 — the cap: one ceiling, two shipped answers, and the overlay inherits neither

`TREE_LEVEL_MAX_TAKE` is 200 rows under a key-ASCENDING sort, so overflow discards the **newest**
cards. Two surfaces already answer that, differently and correctly:

| surface                            | affordance                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `/roadmap`                         | the `+ N more` / _Showing N of M_ / **Show all** tile, at every level (roadmap §7)    |
| the plan DETAIL (`/plans/[id]`)    | opens in the **LIST** when the arrival level's untruncated total exceeds the cap (§6) |
| **the planning workspace OVERLAY** | **the tile** — decided here                                                           |

**The overlay has no list view**, so §6's arm cannot reach it: that arm chooses which VIEW a reader
lands in, and the overlay has one. The tile is the only affordance that can exist there, and the
roadmap's reasoning for it holds unchanged — the cap is per-level, so a drilled level is as silent as
the root.

**The DETAIL keeps §6 and gains the tile too.** They answer different questions and are not
alternatives: §6 decides the ARRIVAL VIEW for the ARRIVAL LEVEL; the tile says a LEVEL is truncated
once the reader is standing on the canvas — after switching views, or after drilling. §6 says in as
many words that it _"changes nothing about what a level contains"_, which is exactly the gap the tile
fills.

## 16.6 DECISION 5 — `PlanReviewCanvas` takes the SAME ruling, for a sharper reason

The plan detail's canvas is the fourth `buildWorkItemLevel` consumer and composes the same way —
`buildWorkItemLevel(wi)` then `mergePlanLevel(committed, items, …)`. It gets decisions 1–3 unchanged.

**And its failure mode under (b)/(c) is worse than the overlay's, which is why the ruling is not
merely consistent but forced.** `mergePlanLevel` pushes any proposal it could not merge onto a
committed node as a standalone node, and its own comment says what that means: _"a `modify` /
`remove` whose target is not at this level (**a drifted plan**)"_. So grouping a proposal's target
does not just hide a frame there — it makes the plan **read as drifted**, which is a false statement
about the plan, on the surface the plan is approved from.

## 16.7 What this settles, for the cards that consume it

| card           | what it takes                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4771** | criteria 1–2 from decision 1; criterion 3 from decision 2 (with its predicate and its constraint); criterion 4 from decision 4; criterion 5 from decision 5 |

**Nothing is TAKEN from `design/roadmap`.** No element it drew is removed and no boundary it set is
moved: this Part adds a conjunct that is inert on the roadmap (which never has a proposal) and rules
on two surfaces that section never addressed.

## 16.8 ⚠️ Planning flags

- **The predicate in decision 2 is the one thing a code card must not re-derive.** The
  `diffStateForItem` trap is a correct-looking wrong answer, and it fails quietly — on a young tree
  with few `done` roots it behaves indistinguishably from the right one.
- **No other flag.** Every element drawn is shipped, and the one number this Part does not own —
  the cap — is cited from `lib/planning/levelCaps.ts` rather than restated.

---

# Part XVII — A proposal FILED into a folder, on the plan review (MOTIR-5406 · Story MOTIR-5310 — `plan-folder-placement.mock.html`)

**Its OWN asset**: `design/ai-planning/plan-folder-placement.mock.html` + `plan-folder-placement.png`,
five panels, plus this section. It draws NO new surface and adds no entrance: the plan detail is
reached as Part I §5 draws it (the left-nav _Plans_ entry, then a row) or from the item a plan was run
on (the pending-plan indicator, `design/work-items/design-notes.md` § _The PENDING-PLAN indicator_).

A plan proposal can now name a folder as the place a card is filed (`folder:<id>`), and until this
Part the review surface could only say where a card hangs by its work-item parent. A folder-placed
proposal has no work-item parent, so the shipped canvas drew it as an ordinary root and the reviewer
approved a placement they never saw.

## 17.0 Drawn against SHIPPED reality — what was rendered, and how

Every node, list row, crumb and rail on the board is the shipped component's own markup: a
throwaway RTL dump rendered `PlanItemNode`, `PlanProposalList` (en and zh) and `PlanReviewRail`
through the shipped `renderWithIntl` harness against `planReviewItem` fixtures, and the canvas
chrome (breadcrumb, the Show changes toggle, the level caption, the emphasis ring and dim) is
`ProjectRoadmapCanvas`'s markup verbatim. The committed epic nodes reproduce
`plan-canvas-grouped-roots.mock.html`'s, and the page's leading token block is lifted from that asset
unchanged. **The NEW elements are exactly five**: the placement line, the folder crumb segment, the
folder side of a diff, the list row's folder fact, and the deleted-folder state.

The stylesheet is Tailwind's real output for this document:

```js
// input.css → postcss([@tailwindcss/postcss]) → inlined as the mock's second <style>
//   @import 'tailwindcss' source(none);
//   @source './page.html';            // the mock's own markup, before inlining
//   @import '@motir/design-system/theme.css';
```

The PNG was exported with `node scripts/render-design-mock.mjs --width 1200` after
`prettier --write` on the mock (`NEW`, 2400×11554).

## 17.1 The workflow spec this Part draws to

Nothing here decides BEHAVIOUR; three sibling cards do, and each panel reads them:

| card                                  | what it settles for the design                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5414** — the append           | `folder:<id>` is accepted as an `add`'s `parentRef` and a `modify`'s `patch.parentRef`, refused in every edge carrier; a folder admits any kind; **a filed card is a ROOT** (depth 1)                         |
| **MOTIR-5423** — materialize          | an `add` is created filed; a `modify` re-parent sets one placement and clears the other; **a folder deleted between append and approve refuses the WHOLE approve**, nothing materializes, the plan stays open |
| **MOTIR-5415** — the plan read        | the review model carries `folderId`, `folderPath` (root first) and `folderMissing` on a folder-placed proposal, and both sides of a `modify`'s placement                                                      |
| **MOTIR-5418** — the review UI builds | the pixels, to this Part                                                                                                                                                                                      |

The folder VOCABULARY is composed, not redrawn: the lucide `folder` glyph in `--el-text-secondary`
and the `Parked ▸ 2025` path form joined with `▸` are `design/work-items/folders.mock.html`'s
(§ _Folders_) and `design/work-items/placement.mock.html`'s (§ _Placement_ — the breadcrumb's folder
segment is text, not a link, and leads the chain).

## 17.2 DECISION 1 — a filed card ARRIVES among the roots, and says where it is filed ON the card

> **⚠️ SUPERSEDED for the planning canvases by Part XVIII (MOTIR-5793, 2026-09-19).** This decision's
> arrival among the roots, and its non-navigating folder crumb segment, rested on _no canvas level is
> a folder_; bug MOTIR-5782 gives both planning canvases folder levels. The text below is kept as the
> record of the decision it was. The LIST body's fact (§17.3) is not affected.

**The arrival rule is unchanged** (Part IX §1): the canvas opens on the level the plan most fills,
counted by `parentNodeId`. A folder-placed proposal has `parentNodeId: null`, so it counts under the
top level, and it is drawn there — **among the other roots, not grouped under its folder path**.

- **Why not a folder level on the canvas.** The canvas draws roadmap LEVELS, one at a time, from the
  roadmap's own per-level read — and neither the roadmap nor that read has a folder level (MOTIR-5309
  decided the roadmap gains no folder display). A grouped folder node would be a level whose
  committed contents the read cannot supply, so it would draw the plan's cards WITHOUT the company
  they keep, which is the whole thing a level is for (Part V panel E, `planLevel.tsx`: _"seeing the
  company a proposed card will keep is most of what 'is this the right place for it?' means"_). And a
  filed card IS a root, for readiness and for the tree (MOTIR-5414) — drawing it anywhere else would
  be a statement about the tree the product does not make.
- **Why it is not grouped into "Not in an epic".** A proposal is never grouped: Part XVI DECISION 2
  keeps every row the plan touches on the road, and a pending `add` is not a committed row. Unchanged.
- **The default view is unchanged too** (Part IX §3 / Part XIII §6). A folder is not a container for
  `planShape`: every folder-placed proposal lands on ONE canvas level, the top one, so a plan filing
  cards into two folders does not straddle.

**The placement line (panel 1b, 2).** A filed `add` spends the node's bottom slot — the slot a
`modify` spends on its diff line, which an `add` never has — on where it will be filed: the folder
glyph, then the path. The LAST segment takes `--el-text` at medium weight (it is the destination);
the rest and the `▸` separators take `--el-text-secondary`. A root `add` with no folder draws no line
at all, exactly as today.

**When a bottom slot is present the title clamps to ONE line** (`block truncate`, the full title in
`title`), and that includes a `modify`'s diff line. Measured in Chromium: the node is a fixed
280 × 124, and a two-line title (38.5px) plus the key plus a 16px slot does not fit: the body's
`overflow-hidden` cuts the second title line through its middle. One clean ellipsis replaces a
half-line.

**The folder crumb segment (panel 1a, 5).** When the canvas is drilled into a filed proposal's
subtree — the arrival level for a filed story WITH children — the breadcrumb gains ONE segment ahead of
the proposal's own crumb: `Roadmap › [folder] Parked ▸ 2025 › New · Importer retries with backoff`.
It is a `<span>`, not a `<button>`: it navigates nowhere, because no canvas level is a folder, and
`placement.mock.html` already rules a folder segment text for the same reason. It carries a
visually-hidden `Folder:` label and the full path in `title`. It appears only when the ROOT-most
proposal of the drilled chain is filed; a committed filed ancestor adds no segment (the canvas reads a
proposal's OWN placement, the story's decision for agents, and never the item page's effective folder).

## 17.3 DECISION 2 — mixed placements: the line on the canvas, a fact on the list row

**Panel 2.** One plan, three placements. On the canvas the filed cards are ordinary roots whose only
difference is the line. In the LIST body the same fact lands where the shipped `under {parent}` sits in
the facts line: **`in [folder] Parked ▸ 2025`**. The list's sections stay the op sections Part VIII
drew — **placement is a fact on the row, never a grouping**; grouping by folder would reorder the one
body whose job is to say what exactly is being approved, by op.

## 17.4 DECISION 3 — a move into or out of a folder is the shipped diff, with a folder side

**Panel 3.** A `modify` that files a committed item, or takes one out, renders in the shipped diff
grammar on both bodies — the canvas `DiffLine` (old side struck, `›`, new side) and the list's
`ChangeLines` (`→`) — with a folder side carrying the glyph and its path.

- **The row is labelled `Placement` whenever EITHER side is a folder.** A folder is not a parent
  (the story's own decision), so `Parent` would be false on those rows. A work-item → work-item move
  keeps the shipped `Parent` label and is byte-identical.
- **The project root reads `Project root`** (`folders.projectRoot`, shipped) once a folder is on the
  other side — never the empty cell the shipped `null` renders, which beside a folder path reads as a
  value that failed to load.
- **A placement change that involves a folder LEADS the change list**, so the one line the card has
  is spent on it. Today `buildChanges` pushes `parent` after the title, sizing and both bodies.
- **Each card is drawn on the level it ARRIVES at**, exactly as a work-item re-parent is today
  (`departingIds` / `parentNodeIdOf`): filed into a folder → the top level (3a); out of a folder under
  `PROD-9` → `PROD-9`'s level (3b). Show changes rings it; its op badge still says `change`.

## 17.5 DECISION 4 — the stale folder has no name left, and Approve is unavailable

**Panel 4.** The folder a proposal names was deleted after the plan was written. **Its name was deleted
with it**, so no surface can say _Parked ▸ 2025_ about it, and none pretends to. (MOTIR-5423 asks the
approve refusal to name "the folder"; there is nothing but an id left to name it by, and an id is not
copy. Every string here names the PROPOSAL.)

**While `planned` (4a):**

- **The card wears the SHIPPED `Out of date` badge** (`--el-tint-yellow`, `triangle-alert`) — the
  surface already has exactly one "this proposal no longer matches the tree" language, and a second
  would be a fourth op language. Its `title` reason is a new one, **Folder deleted since planned**,
  beside the shipped _Parent removed since planned_.
- **Its placement line becomes `Folder deleted`**, behind lucide `folder-x`, the words in
  `--el-text-strong`. Text first; the glyph and the badge are the second and third channels.
- **The rail's shipped stale summary lists it** with the same reason, and **Approve is DISABLED**, with
  the hint naming the two real exits: _Approve is unavailable while 1 item is filed into a deleted
  folder. Ask Motir to revise the plan, or decline it._ A control whose press the server is certain to
  refuse, and that no retry can clear, is a dead control wearing a live face — the shape
  MOTIR-3240 found on `generating`. Decline stays enabled.
- **The list row** takes the shipped `may be out of date` pill and the `Folder deleted` fact in place
  of `in [folder] …`.

**After a refused approve (4b)** — the folder was deleted after the page loaded, so Approve was live and
the server refused the WHOLE approve: the rail's shipped `role="alert"` slot says **Nothing was created
— "{title}" is filed into a folder that was deleted after this plan was written.** It is keyed on the
refusal's code rather than falling to the generic `actionError`. The island refetches, which puts the
card, the summary and the hint into 4a's state underneath the alert; the plan stays _Ready to review_.

## 17.6 DECISION 5 — a long path collapses by COUNT, never by measurement

**Panel 5.** One rule, two ceilings, so a test can assert it without a layout engine:

| where                     | renders whole | longer paths collapse to |
| ------------------------- | ------------- | ------------------------ |
| the card's placement line | ≤ 3 segments  | `first ▸ … ▸ last`       |
| the breadcrumb segment    | ≤ 3 segments  | `first ▸ … ▸ last`       |
| the list row's fact       | ≤ 4 segments  | `first ▸ … ▸ last`       |

The first segment says whose, the last says where; the middle is what a reader can most afford to lose.
Inside that, every segment still `min-w-0 truncate`s as the backstop, and the `▸` separators never
shrink. **The full path is always the element's `title` (hover) and a visually-hidden span (its
accessible name)**, so hover and focus both read it whole.

## 17.7 Elements — primitive and tokens

| element                   | composes                                                                             | colour                                                              | shape                                       |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------- |
| placement line (card)     | `PlanItemNode`'s bottom slot; lucide `folder` 14px, `aria-hidden`; sr-only full path | glyph + path `--el-text-secondary`; last segment `--el-text` medium | `mt-1.5`, `text-xs`, one line               |
| deleted-folder line       | the same slot; lucide `folder-x`                                                     | glyph `--el-text-secondary`; words `--el-text-strong` medium        | as above                                    |
| stale badge               | the SHIPPED `stale-badge`                                                            | `--el-tint-yellow`, `--el-text-strong`                              | `--radius-badge`                            |
| folder crumb segment      | a `<span>` in the canvas breadcrumb's `<ol>`; lucide `folder`; sr-only `Folder:`     | `--el-text-secondary`; no hover (not a control)                     | `max-w-[18rem]`, `px-1.5 py-0.5` as `Crumb` |
| diff folder side (canvas) | `DiffLine` side; lucide `folder` 12px                                                | old side `--el-text-secondary` struck; new side `--el-text` medium  | as shipped                                  |
| diff folder side (list)   | `ChangeLines` `<dd>` side; lucide `folder` 12px                                      | old `--el-text-secondary` struck; new `--el-text-strong` semibold   | as shipped                                  |
| list folder fact          | a `<span>` in the row's facts line; lucide `folder` 12px                             | `--el-text-secondary`                                               | `truncate`                                  |
| Approve, disabled         | the SHIPPED `Button` primary, `disabled`                                             | as shipped (`disabled:opacity-50`)                                  | as shipped                                  |
| refusal                   | the SHIPPED rail `role="alert"` paragraph                                            | `--el-danger-on-surface`                                            | as shipped                                  |

No new primitive, no new token, no Tier-0 `--color-*`, no raw hue.

## 17.8 Which review-model field each drawn element reads

| element                                  | reads                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| placement line, list folder fact         | `folderPath` (non-null ⇒ filed), `folderMissing: false`                                                    |
| deleted-folder line + badge + rail entry | `folderMissing: true`                                                                                      |
| Approve disabled + its hint              | any item's `folderMissing` on a `planned` plan                                                             |
| folder crumb segment                     | the ROOT-most proposal of the drilled chain's `folderPath`                                                 |
| `Placement` diff row                     | the `parent` change whose `from` or `to` side is a folder — its path, or `root`, or a work-item identifier |
| the refusal alert                        | MOTIR-5423's refusal code, and the refused proposal's `title`                                              |

A `modify`'s two sides must arrive TYPED — a folder path, a work item, or the project root — rather
than as the two bare strings the `parent` change carries today, because the glyph and the label both
depend on which. MOTIR-5415 owns the shape.

## 17.9 Copy — English and Chinese

| key (suggested)                              | en                                                                                                                                                      | zh                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `planReview.placementFiledIn`                | Filed in {path}                                                                                                                                         | 归档于文件夹 {path}                                                                  |
| `planReview.listInFolder`                    | in {path}                                                                                                                                               | 位于 {path}                                                                          |
| `planReview.field_placement`                 | Placement                                                                                                                                               | 位置                                                                                 |
| `planReview.folderMissing`                   | Folder deleted                                                                                                                                          | 文件夹已删除                                                                         |
| `planReview.folderMissingAria`               | Filed in a folder that was deleted                                                                                                                      | 归档到的文件夹已被删除                                                               |
| `planReview.staleFolderRemoved`              | Folder deleted since planned                                                                                                                            | 规划后文件夹已被删除                                                                 |
| `planReview.approveHintFolderMissing`        | Approve is unavailable while {n, plural, one {# item is} other {# items are}} filed into a deleted folder. Ask Motir to revise the plan, or decline it. | 有 {n} 个工作项归档到了已删除的文件夹，暂时无法批准。请让 Motir 修改计划，或拒绝它。 |
| `planReview.approveFolderMissingRefused`     | Nothing was created — “{title}” is filed into a folder that was deleted after this plan was written.                                                    | 未创建任何内容 —“{title}”归档到的文件夹在计划写好后已被删除。                        |
| `folders.projectRoot` (shipped)              | Project root                                                                                                                                            | 项目根目录                                                                           |
| `folders.breadcrumbFolderLabel` (MOTIR-5381) | Folder:                                                                                                                                                 | 文件夹：                                                                             |

Every other string the panels render already ships (`planReview.*`, `roadmap.canvas.*`).

## 17.10 a11y

The placement line, the crumb segment and the list fact are TEXT, never controls, so a reviewer without
`work_item:edit` — or without `ai:decide_plan` — sees exactly the same pixels; nothing on this Part is an
action except the shipped Approve / Decline. Every glyph is `aria-hidden`; the path is always in the
accessible name. State is never colour alone: _Folder deleted_ and _Out of date_ are words.

## 17.11 GIVES / TAKES

| work item                    | GIVES / TAKES       | what                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5418** — review UI   | **GIVES**           | the placement line and its slot; the one-line title clamp whenever a slot is present (a `modify` too); the folder crumb segment and when it appears; the list fact; the `Placement` label rule and `Project root`; the stale badge reason, the deleted-folder line, the disabled Approve and its hint; the keyed refusal copy; the count-based collapse rule; every string above |
| **MOTIR-5415** — plan read   | **GIVES**           | a `modify`'s placement sides arrive typed (folder / work item / root); a placement change involving a folder sorts FIRST in `changes`; `folderMissing` is readable by the rail for the Approve disable                                                                                                                                                                           |
| **MOTIR-5423** — materialize | **GIVES**           | the refusal's copy names the proposal, not the folder — the folder's name no longer exists; the code must be distinct from the generic action error                                                                                                                                                                                                                              |
| **MOTIR-5414** — the append  | **TAKES a premise** | a filed card is a root, which is why it arrives among the roots                                                                                                                                                                                                                                                                                                                  |
| Parts IX, XIII, XVI          | **lose nothing**    | the arrival rule, the default view, the grouping predicate and the Show changes treatment are applied unchanged                                                                                                                                                                                                                                                                  |

## 17.12 What Part XVII does NOT draw

The folder picker, the folder tree and the quick view's Folder field (`design/work-items/`), any way
for a reviewer to CHANGE a proposal's folder (a proposal is read, and changed by revising the plan —
Part V §3), the `get_plan` text and the `/api/v1` payload (MOTIR-5415), and the dark board.

## 17.13 ⚠️ Planning flags

- **MOTIR-5423's refusal cannot name the folder.** The row is gone by the time approve re-checks, so the
  typed error can carry the id and the proposal, not a name. Its criterion _"naming the folder and the
  proposal"_ should read _the folder's id and the proposal_; the copy above names the proposal only.
- **A `modify` with a two-line title is already cut in half by its diff line today** (the same fixed
  124px, measured in Chromium). MOTIR-5418 fixes it as part of the slot rule above rather than as a
  separate card, because the placement line is the second tenant of the same slot.

---

# Part XVIII — FOLDERS as levels on the planning canvases (MOTIR-5793 · bug MOTIR-5782 — `plan-folder-levels.mock.html`)

**Its OWN asset**: `design/ai-planning/plan-folder-levels.mock.html`, seven sheets, a DELTA. It
amends, and does not edit, `plan-folder-placement.mock.html` (Part XVII) and
`design/roadmap/roadmap--folder-node.mock.html` (MOTIR-5713).

**What changed underneath.** MOTIR-5710 gave `/roadmap` folder LEVELS: its root reads `folders=1`,
leaves filed rows out on the SERVER (`TreeFolderLevel` `excludeFiled`), and draws each root folder
as the shipped `FolderNode`, a door to a `folderId=` level. Bug MOTIR-5782 opts the two planning
canvases into the same read — the planning overlay (`PlanChangeCanvas`, beside the planning chat)
and the plan review (`PlanReviewCanvas`, `/plans/[id]` and `GenerationFlow`). Two approved
decisions were drawn on the premise that no planning canvas has a folder level, and that premise is
now false:

- **Part XVII §17.2 (MOTIR-5406, DECISION 1)** — _"a filed card ARRIVES among the roots"_, and its
  folder crumb _"navigates nowhere, because no canvas level is a folder"_.
- **`design/roadmap/design-notes.md` DECISION 8 (MOTIR-5713)** — _"The plan-review canvas's folder
  crumb … That canvas has no folder level to navigate to, so its text crumb stands."_

**This Part SUPERSEDES both, for the two planning canvases only.** `/roadmap`, the plan review's
LIST body (Part XVII §17.3 — placement stays a fact on the row) and the run canvas are unchanged.

## 18.0 Drawn against SHIPPED reality — what was used, and how

Every card, crumb and control is the shipped component's markup, class string for class string:
`WorkItemNode`, `FolderNode`, `LevelGroupNode` and `FolderEmptyLevel`
(`components/planning/WorkItemNode.tsx`), the breadcrumb and `Crumb`
(`components/planning/ProjectRoadmapCanvas.tsx`, including MOTIR-5742's folder crumb and the
Show changes toggle's shipped pressed / disabled classes), and `PlanItemNode`'s `add` / `modify`
frames, placement line, diff line and stale badge as Part XVII lifted them. The title follows the
MOTIR-5459 rule (`line-clamp-2` with no `block`; `block truncate` only when a bottom slot is
present). Glyphs are the installed `lucide-react@1.16.0` icon nodes. CSS is compiled by Tailwind v4
from the real `app/globals.css` + `packages/design-system/theme.css` at `origin/main` `e881bfb86`,
over the mock's own markup only. Positions use the canvas layout constants (`NODE_W` 280, `NODE_H`
124, `GAP_X` 80, `GAP_Y` 72, origin 40 — `lib/planning/projectCanvasModel.ts`). The asset was
rendered headless in Chromium and read back (no page errors; the new badge resolves to
`--el-surface` fill and `--el-accent-on-surface` ink). The builder was throwaway and is not
committed.

**One shipped overflow, left as shipped and not drawn around.** A committed container card with a
TWO-line title and a progress meter overflows its 124px box by roughly a line in this render (the
body is `overflow-hidden`, so the second title line is cut). MOTIR-5713's mock shows the same. It is
not this Part's subject, so the mock uses one-line epic titles rather than restyle the card; see
§18.10.

## 18.1 DECISION 1 — the committed tree is MOTIR-5713's, unchanged (sheet 2)

On both canvases the root reads `folders=1` and composes exactly as `/roadmap` does since MOTIR-5741:
**epics, then the root folders, then _Not in an epic_**, which now holds only UNFILED parentless
non-epics. A folder card drills to its `folderId=` level: its child folders, then its filed items.
The cap tile counts work items only; folders are never cut. An empty folder's level renders the
shipped `FolderEmptyLevel` (sheet 7), never the generic drilled-empty copy. **Nothing of MOTIR-5713
decisions 1–7 is carved out** — a canvas whose subject is a proposed change still shows the
committed tree it changes, and showing a different committed tree from `/roadmap` is the defect.

Part XVI DECISION 2's third conjunct (a row the proposal TOUCHES stays on the road, out of the
grouped node) is **unchanged**: it is a predicate over the rows the root read RETURNS, and a filed
row is no longer one of them — it is read on its folder's level, where decision 2 draws it.

## 18.2 DECISION 2 — a proposal is drawn on the level where it will SIT (sheets 3–5)

**The level key of a proposal is its folder when its placement is a folder, else its parent:**
`folder:<folderTrail leaf id> ?? parentNodeId`. Concretely:

| proposal                                                | drawn on                                                 |
| ------------------------------------------------------- | -------------------------------------------------------- |
| an `add` whose `parentRef` is `folder:<id>`             | that folder's level                                      |
| a `modify` / `remove` of a committed card that is FILED | its folder's level (where the committed read carries it) |
| a `modify` that MOVES its target into a folder          | the destination folder's level (decision 4)              |
| an `add` under a committed or proposed work item        | that work item's level, as today                         |
| an unfiled root proposal                                | the root, as today                                       |
| a folder-placed proposal whose folder is gone           | the root (decision 6)                                    |

**Why — rung 2, and it is a constraint rather than a preference.** The root read now drops filed
rows ON THE SERVER. A `modify` / `remove` whose target is filed, and a materialized `add` (whose
`nodeId` is the committed row's own id), can merge onto their committed node only on the level whose
read CARRIES that node. Drawn anywhere else, the merge has nothing to land on:
`decoratePlanChangeLevel` appends the proposal a second time as a keyless node — **bug MOTIR-3206,
re-created** — and `mergePlanLevel` pushes it as a standalone node, which _"reads as a drifted plan"_
(Part XVI §16.6). Part XVI kept a touched row ON THE ROAD for exactly this reason; with the grouping
done client-side that meant the root, and with the folder read done server-side it means the folder.
**The same rule, applied to where the read now puts the row.** An un-materialized `add` has no such
constraint, and follows it anyway: one rule for every op, so a filed `add` sits beside the committed
work it will keep company with (Part V panel E) and the canvas shows the tree the plan will produce.

**The placement line (Part XVII §17.2) is not drawn inside the folder.** The breadcrumb already says
where the reviewer is standing, so the `add` gives its bottom slot back and its title returns to two
lines (sheet 4). The line is still drawn where it says something the level does not: the stale case
(decision 6). The LIST body keeps `in [folder] Parked ▸ 2025` unchanged.

**The arrival level (plan review; Part IX §1).** The rule is unchanged except for what counts as a
level: count every proposal at its level key above, take the level the plan most fills; the TIE-BREAK
is the deeper level, where depth is the arrival trail's length **with folder crumbs counted**; an
exact tie goes to the level holding the plan's first proposal in list order (the order the rail and
the list already use). **A plan that files everything into ONE folder arrives on that folder.** A
plan filing into TWO arrives on whichever holds more; on a tie, the deeper one. Sheet 5 is sheet 3's
plan: the proposed story's own level holds 2 and wins. **The overlay keeps its shipped arrival** (it
opens where the conversation is anchored) and only gains the levels.

## 18.3 DECISION 3 — a CLOSED folder that holds proposals says so, on the card (sheet 3)

Decision 2 moves proposals off the root and into folders, so a reviewer standing at the root could
see a plain folder card with work changing behind it. **The folder card gains a `changes` badge** in
its top-row slot — the slot MOTIR-5713 decision 3 left empty because a folder has no status. It is
the shipped `add`-op badge (`bg-(--el-surface) text-(--el-accent-on-surface)`, `--radius-badge`,
`text-[11px] font-semibold`) with the lucide `folder-pen` glyph, reading **`N change(s)`**.

- **N counts DEEP**: every proposal of any op whose `folderTrail` contains this folder's id — the
  proposals filed in it, in its sub-folders, and under work items filed in it. Sheet 3's **Parked**
  reads 4 (a story, its two subtasks, one move-in) though only the move-in is its direct child.
- **Show changes** (armed on arrival, Part XIII §3) treats a folder card like a card: **ringed** when
  its count is non-zero, **dimmed** otherwise. On a level whose only proposals are behind folders,
  Show changes is therefore NOT "nothing to light" — Part XIII §3d's disabled reasons count folder
  cards with a non-zero badge as touched.
- **Not drawn on `/roadmap`** — it has no plan — and **not drawn on a crumb** (a crumb names where you
  are; the badge says what is behind a door).
- **Why a folder card and not an epic card.** An epic card's face already carries a status, a meter
  and readiness chrome, and the shipped canvas gives committed containers no such signal; the arrival
  rule, the list and the locate walk are how a reviewer reaches proposals under them. A folder card
  has an empty slot built for exactly one fact, and a folder is a drawer a reviewer has no reason to
  expect work to be changing in. This is a decision about folders, not a gap left open for epics.
- **Why this does not contradict Part XVI §16.4** (the grouped node says nothing about its contents).
  §16.4 needed no signal because decision 2 there kept touched rows OUT of the group. Here the server
  read puts them IN the folder, so the signal is the only thing between a reviewer and an unseen
  proposal.

## 18.4 DECISION 4 — a move into or out of a folder is drawn once, at its DESTINATION (sheet 6)

The re-parent rule MOTIR-3867 set, extended to folders: a `modify` whose placement changes is drawn
on the level it moves TO, carrying Part XVII §17.4's `Placement` diff line (the source struck, the
destination beside it). It is NOT drawn at its source: there it is a card about to leave, and after
approve the source's read no longer carries it. When the source is a folder, that folder's badge
does NOT count it (the badge counts where proposals will SIT); when the source is the root nothing
marks it, exactly as a re-parent leaves its old parent. The mirror case — `Parked → Project root` —
is drawn at the root with the sides swapped.

## 18.5 DECISION 5 — every folder crumb NAVIGATES, on both planning canvases (sheets 4–6)

The breadcrumb is `Roadmap › [folder] … › [folder] › work item › …`, each folder the shipped `Crumb`
button with the 14px `folder` glyph and a visually-hidden `Folder:` — MOTIR-5713 sheet 5 and
MOTIR-5742, unchanged, including the middle collapse past three folder crumbs. **Part XVII's text
crumb segment (MOTIR-5418's `crumbFolderPath`) is RETIRED on these canvases**: it stood in for a
folder level that did not exist, and drilling into a filed proposal now passes THROUGH its folder
levels, so the folders are real crumbs ahead of it. The arrival trail (decision 2) and the locate
walk build the same chain.

## 18.6 DECISION 6 — the stale folder has no level, so its proposal stays at the root (sheet 7)

`folderMissing: true` means the folder was deleted after the plan was written — there is no level to
draw the proposal on. It is drawn among the roots with Part XVII §17.5's `Out of date` badge and
`Folder deleted` line, **unchanged**, and approve stays unavailable. It counts toward the ROOT for
arrival.

## 18.7 DECISION 7 — the review model owes a FOLDER TRAIL (a data seam, not a pixel)

Decisions 2, 3 and 5 all need a proposal's folder chain **with ids**: the level key of an ancestor
folder, the deep count, and a navigable crumb per folder. `PlanReviewItemDto` carries `folderId`
(the leaf only) and `folderPath` (names only), and nothing at all for a proposal under a committed
work item that is itself filed (its `parentTrail` starts below the folder). No session route returns
a folder trail — `foldersService.getFolderTrail` is reached only from `/roadmap`'s server page.
**So the review read gains `folderTrail: Array<{ id; name }>`**, root first: the proposal's own
folder when it is folder-placed; else the effective folder of its root-most committed ancestor; else,
under a proposed parent, the root-most proposed ancestor's; else `[]`. `folderPath` stays, equal to
the trail's names. This is its own card — neither canvas card may change `planReviewService` — and it
is proposed on plan `cmu8n8bwx009ahwtxt750aeeb` under bug MOTIR-5782, with both canvas cards
`blocked_by` it (§18.12).

## 18.8 Which review-model field each drawn element reads

| element                                       | reads                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| the level a proposal is drawn on              | `folderTrail` (leaf id) when folder-placed, else `parentNodeId` (decision 2)    |
| a folder card's `changes` badge + its ring    | count of proposals whose `folderTrail` contains the card's folder id            |
| the arrival level and its trail               | the same level key per proposal; `folderTrail` + `parentTrail` build the crumbs |
| each folder crumb                             | `folderTrail[i]` (`id` for the level, `name` for the label)                     |
| the `Placement` diff line                     | `placement.from` / `placement.to` (MOTIR-5415), unchanged                       |
| stale badge + `Folder deleted` line           | `folderMissing: true`, unchanged                                                |
| folder card, folder level, empty folder state | the roadmap level read with `folders=1` / `folderId=` (MOTIR-5740), unchanged   |

## 18.9 Copy — English and Chinese

| key (suggested)                | en                                                                     | zh                  |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------- |
| `planReview.folderChanges`     | {n, plural, one {# change} other {# changes}}                          | {n} 项变更          |
| `planReview.folderChangesAria` | {n, plural, one {# proposed change} other {# proposed changes}} inside | 内含 {n} 项拟议变更 |

The folder card's accessible name becomes `roadmap.canvas.folder.aria` followed by
`planReview.folderChangesAria` when the count is non-zero. Every other string on the sheets already
ships (`roadmap.canvas.folder.*`, `folders.breadcrumbFolderLabel`, `planReview.*`).

## 18.10 a11y

The badge is TEXT with an `aria-hidden` glyph and a visually-hidden `proposed inside`; the count is
in the card's accessible name, so a screen-reader user hears it on the door before opening it.
State is never colour alone: the ring under Show changes is backed by the badge's words. The folder
crumb is a real `<button>` in the breadcrumb `<nav>`'s list (MOTIR-5742). The badge ink is
`--el-accent-on-surface` on `--el-surface`, the shipped `add` badge pair.

## 18.11 GIVES / TAKES — swept over the tree

The sweep: open work items naming `PlanReviewCanvas`, `PlanChangeCanvas` or `planReviewService`
(`search_work_items`, text), plus a meaning search for plan-canvas placement / arrival / crumb /
Show changes — run 2026-09-19. Everything it returned that is not `done` is listed.

| work item                                                    | GIVES / TAKES        | what                                                                                                                                        |
| ------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5794** — the overlay canvas                          | **GIVES**            | decisions 1–6 on `PlanChangeCanvas` and its diff helpers: the folder read, the folder level, the level key, the badge, the ring, the crumbs |
| **MOTIR-5795** — the plan-review canvas                      | **GIVES**            | decisions 1–6 on `PlanReviewCanvas` / `planLevel.tsx`, plus the arrival rule's level key and tie-break (decision 2)                         |
| **the folder-trail read** (plan `cmu8n8bwx009ahwtxt750aeeb`) | **GIVES**            | `PlanReviewItemDto.folderTrail` (decision 7)                                                                                                |
| **MOTIR-5796** — the E2E                                     | **GIVES**            | the journeys sheets 2–7 draw, on both canvases                                                                                              |
| **MOTIR-5418** (`done`)                                      | **TAKES**            | its canvas text crumb segment and, inside a folder, its placement line on an `add`. Not reopened; MOTIR-5795 retires them on the record     |
| **MOTIR-5406** (`done`)                                      | **TAKES a DECISION** | §17.2's arrival among the roots and its non-navigating crumb, for the planning canvases. Its text stays, marked superseded                  |
| **MOTIR-5713** (`done`)                                      | **TAKES a DECISION** | decision 8's plan-review exclusion. Its text stays, marked superseded; decisions 1–7 are composed unchanged                                 |
| **MOTIR-5649** (`todo`)                                      | **none**             | touches `planReviewService` for the explanation field; disjoint from `folderTrail`                                                          |
| Parts IX, XIII, XVI                                          | **lose nothing**     | the arrival rule (a level key added), the armed Show changes (folder cards counted as touched), the grouping predicate                      |

## 18.12 What Part XVIII does NOT draw

The run canvas (`ids=` member sets take no folder treatment), the onboarding canvas, the Children
panel, `/roadmap`, the plan review's list body, any way to CHANGE a proposal's folder, the dark board,
and the committed-container overflow noted in §18.0.

## 18.13 ⚠️ Planning flags

- **Decision 7 is a data seam no card owned.** The split of MOTIR-5782 bounded both canvas cards off
  `planReviewService` and told them to report a missing field rather than invent it — that is what
  happened here. The owner card and both `blocked_by` edges are on plan `cmu8n8bwx009ahwtxt750aeeb`;
  **the canvas cards are not buildable until it is approved and landed.**
- **The two-line-title overflow on a committed container card with a meter (§18.0)** is shipped
  behaviour visible in this render and in MOTIR-5713's; it was not measured against the app's real
  fonts here, so it is recorded as an observation, not filed as a defect.

---

# Part XIX — the plan review: a committed card MOVED under a PROPOSED parent, and a REMOVE's REASON (MOTIR-6053 · Story MOTIR-6013 — `plan-review--surgical-edits.mock.html`)

**Its OWN asset**: `design/ai-planning/plan-review--surgical-edits.mock.html` (seven sheets, delta panels
only), plus this section. It draws **no new surface and no new entrance**: the plan review is reached
exactly as Part I §5 draws it (the left-nav _Plans_ entry, then a row) or from the item a plan was run
on (the pending-plan indicator, `design/work-items/design-notes.md` § _The PENDING-PLAN indicator_).

It **amends three approved designs** and redraws none of them:

| amended asset                                        | card           | what this Part extends                                                                     |
| ---------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `design/ai-planning/plan-canvas-arrival.mock.html`   | **MOTIR-3259** | Part IX §1.3 — the crumb that names a proposed parent, `New · <title>`; Show changes       |
| `design/ai-planning/plan-folder-placement.mock.html` | **MOTIR-5406** | Part XVII §17.4 — the placement row under Show changes, and the bottom-slot rule (§17.2)   |
| `design/ai-planning/peek-proposal-mode.mock.html`    | **MOTIR-4182** | Part XIV §4 / §8 — the per-op header and the `remove` arm, where a remove's reason belongs |

## 19.1 The workflow spec this Part draws to

Nothing here decides behaviour. motir-core `docs/decisions/agent-authored-plans.md` **AMENDMENT 18**
does (the story's cards call it _AMENDMENT 17_; open draft #3052 took that number first):

| source                                | what it settles for the design                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AMENDMENT 18 §1** — MOTIR-6050      | a `modify` may re-parent a COMMITTED card under an `add` in the same plan (`patch.parentRef` = `planItem:<id>`); approve creates the add first, then moves the card under it; a decline moves nothing |
| **AMENDMENT 18 §2** — MOTIR-6051      | a second `modify` of one card MERGES into the plan's one `modify`, so a card moved AND edited is still ONE proposal with one change list                                                              |
| **AMENDMENT 18 §3** — MOTIR-6052      | a `remove` carries an optional `removeReason` (trimmed, ≤ 2000 chars, blank = none); every plan written before it has none; it is written into the `archived` revision at approve                     |
| **MOTIR-6055** — the review UI builds | the pixels, to this Part                                                                                                                                                                              |

## 19.2 Drawn against SHIPPED reality — what was rendered, and what it settled

Every node, list row and crumb is the shipped component's own markup: a throwaway RTL dump rendered
`PlanItemNode` and `PlanProposalList` through the shipped `renderWithIntl` harness against
`planReviewItem` fixtures, at `parent/MOTIR-6013-surgical-tools` `b35c53fce` (= `origin/main`
`67ad15aa4` plus the amendment, which changes no code). The canvas chrome (breadcrumb, folder crumbs,
Show changes) is Part XVIII sheet 5's, and the peek header is Part XIV panel 4's, identity re-pointed.
The stylesheet is Tailwind's real output compiled from this document's class attributes only, with
`theme.css`'s `.style-vignette` rules removed. The harness was deleted before this asset landed.

**What the render settled (sheet 1):** a `modify` whose `patch.parentRef` is a temp-ref renders the
RAW id — `Parent PROD-7 › planItem:pi_s` on the canvas diff line and `PROD-7 → planItem:pi_s` in the
list — because `planReviewService`'s `nameParent` falls back to the id itself for a row neither read
returned. The canvas PLACEMENT is already right: `parentNodeIdOf` resolves the temp-ref through
`resolveNodeRef`, so the node is already drawn on the proposed story's level. Only the NAME is wrong.
And a `remove` has no slot anywhere for a reason.

## 19.3 DECISION 1 — a proposed parent is named `New · <title>`, the crumb's own grammar (sheets 2, 3)

The TO side of the moved card's `Parent` change reads **`New · Webhook delivery guarantees`**: the
string `workItemCrumbLabel(identifier ?? proposedCrumb, title)` already puts in the breadcrumb of the
level the card is drawn on (Part IX §1.3). The reader sees the same words in the crumb and on the card.

- **Never the `planItem:` id.** It is an internal token, and on the one surface whose promise is that
  nothing is real until approve, a placeholder key would assert a work item that does not exist.
- **Text first, and no second channel is added.** The word `New` IS the marker. The crumb carries
  the accent ink, dashed border and `+` glyph as further channels because it is a control; a diff
  VALUE stays in the shipped value ink, like every other value on that line.
- **The label stays `Parent`.** Part XVII §17.4 relabels the row `Placement` only when a FOLDER is on
  either side. A proposed story is a work-item parent, so the row is the shipped `Parent` row.
- **A folder-filed proposed parent (sheet 3)** changes nothing on the card: the folder crumbs compose
  ahead of the proposed crumb exactly as Part XVIII draws them. The folder is the PARENT's placement,
  not the moved card's.
- **The canvas LEVEL is unchanged** (Part XVIII decision 2): the card is drawn where it arrives — on
  the proposed story's level, beside that story's own proposed children.
- **The truncated case.** On the 280px node the line ellipsizes; the TO span carries the full string
  in `title`. The list row never truncates it.

## 19.4 DECISION 2 — a merged `modify` is drawn as ONE modify (not drawn)

A card that is both moved and edited in one plan is ONE `modify` after AMENDMENT 18 §2's merge, with
one change list. The node's diff line shows the first change and counts the rest (`+N more`), the list
shows every change line, exactly as today. Nothing new to draw, so this Part draws nothing for it.

## 19.5 DECISION 3 — a remove's reason: the node's bottom slot, a list row, a header band (sheets 4–6)

The reason is written BY the planner FOR the reviewer, so it is shown verbatim and never translated.

- **Canvas node (sheet 5).** A `remove` never spends the bottom slot (only a `modify`'s diff line and
  a stale folder do), so the reason takes it: the label **`Reason`**, then the text on ONE line with an
  ellipsis and the full text in `title`. Taking the slot clamps the title to one line, the rule Part
  XVII §17.2 set for every slot tenant. The node is a glance; the full reason is one click away.
- **List row (sheet 4).** A `Reason` row in the SAME label/value grid a `modify`'s change lines use
  (`grid-cols-[6rem_1fr]`, the uppercase label), under the facts line. The value WRAPS — the list is the
  body that says exactly what is being approved.
- **Peek (sheet 6).** A band directly under the header row, inside the header region (Part XIV §4 puts
  the op in the header; the reason belongs to the op): `bg-(--el-surface-soft)`, a bottom border, the
  uppercase `Reason` label and the full text, wrapping. It sits ABOVE the target's own title, because a
  reader deciding a removal needs the why before the what.
- **No reason ⇒ nothing drawn.** Every legacy plan has none. No empty `Reason` row, no `—`, no band;
  the node, the row and the header are byte-identical to today (`PROD-19` in sheets 4–5, the third peek
  in sheet 6).

## 19.6 DECISION 4 — the decided axis (sheet 7)

Part VI's treatments, unchanged:

- **Approved.** The add exists, so the moved card is drawn under the CREATED story and the TO side
  names it by its NEW key (`PROD-60`), exactly as a committed parent is named today. The list's
  `Applied` row reads `PROD-7 → PROD-60`.
- **Declined.** Nothing was created or moved, so the card is drawn where it still is, on its own
  parent's level. The line keeps `New · <title>`, and the chip's `declined` segment is what says it did
  not happen (Part VI §3's remedy for a future-tense signal on a declined proposal).
- **A remove's reason stays on both outcomes.** It is the record of why the removal was proposed.

## 19.7 Which review-model field each drawn element reads

| element                         | reads                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the `Parent` change's TO side   | `changes[].to` for `field: 'parent'` — **MOTIR-6055 must emit** `proposedCrumb · <the add's title>` for a temp-ref parent (today: the raw id), and after approve the materialized row's identifier |
| its `title` attribute           | the same string                                                                                                                                                                                    |
| the node's placement on a level | `parentNodeId` (shipped, already the add's node id)                                                                                                                                                |
| the reason slot / row / band    | a NEW `removeReason: string \| null` on `PlanReviewItemDto`, read from the `PlanItem` column MOTIR-6052 adds; `null` ⇒ nothing drawn                                                               |

## 19.8 Copy — English and Chinese

| key                        | en     | zh   | note                                                                                       |
| -------------------------- | ------ | ---- | ------------------------------------------------------------------------------------------ |
| `planReview.proposedCrumb` | New    | 新   | REUSED — the key-slot word of a proposed parent, now also on the `Parent` change's TO side |
| `planReview.removeReason`  | Reason | 原因 | **NEW** — the label on the node slot, the list row and the peek band                       |

The proposed parent reads `New · <title>` / `新 · <title>`, joined with the shipped `·` of
`workItemCrumbLabel`. Both catalogs change in the same PR; a key in one is a parity failure.

## 19.9 a11y

- The reason is TEXT in all three places, never a tooltip alone; the node's `title` only adds the
  un-truncated tail.
- The proposed parent is marked by the word `New`, never by colour.
- The peek band is plain flow content inside the dialog, read after the header row and before the title.

## 19.10 GIVES / TAKES

- **GIVES MOTIR-6055**: §19.3's TO-side string and its `title`, §19.5's three placements and the
  no-reason rule, §19.6's decided naming, §19.7's two data seams, §19.8's one new key.
- **GIVES MOTIR-6058** (E2E + acceptance video): the visible strings to assert — `New · <title>` on the
  moved card, `Reason` plus the reason text on the remove, and `PROD-7 → <created key>` after approve.
- **TAKES** Part IX §1.3 (the crumb), Part XVII §17.2 / §17.4 (the slot rule, the placement row),
  Part XVIII decision 2 (the arrival level), Part XIV §4 / §8 (the header, the remove arm), Part VI §3
  (the decided treatments).

## 19.11 What Part XIX does NOT draw

- The **item page's history** row for the `archived` revision that now carries the reason (AMENDMENT
  18 §3 (a)). It renders through the shipped activity feed; if that feed does not show a revision's
  `diff.reason`, that is a separate surface to design, not this delta's.
- The plan **timeline** event for a merged `modify` (AMENDMENT 18 §2 records it as an `edited` event,
  which Part X already draws).
- Any new entry point.

## 19.12 ⚠️ Planning flags

- **The numbering.** The story's cards cite AMENDMENT 17; it landed as **18**. Read every "17" under
  MOTIR-6013 as this amendment.

---

# Part XX — the plan review shows a leaf's DIFFICULTY (MOTIR-6134 · Story MOTIR-6095 — `plan-review--difficulty.mock.html`)

**Its OWN asset**: `design/ai-planning/plan-review--difficulty.mock.html` (seven sheets, delta panels
only), plus this section. It draws **no new surface and no new entrance**. The ACCESS PATH is
unchanged: the plan review is reached exactly as today, from a row on the **Plans** page (Part I §5)
or from the **To approve** list. Nothing about how a reviewer arrives is redrawn.

It **amends two approved designs** of this area and redraws neither:

| amended asset                                              | card           | what this Part extends                                                                                            |
| ---------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `design/ai-planning/plan-review--surgical-edits.mock.html` | **MOTIR-6053** | Part XIX, the latest review delta: the node's top row and bottom slot, the list's facts line and label/value grid |
| `design/ai-planning/peek-proposal-mode.mock.html`          | **MOTIR-4182** | Part XIV §3 / §4: the proposal-mode rail, its `changed` mark and its `{n} of {m}` count line                      |

It **composes** the difficulty glyph and label from **MOTIR-6097**'s
`design/work-items/core-fields--difficulty.mock.html` (verdict approved, published at `bfe3876b`).
That published asset predates the fourth level. **The version composed here is the one on `main` at
`b22dc0a09`** (`git log -1 --format=%h -- design/work-items/core-fields--difficulty.mock.html`, the
merge of MOTIR-6016, PR #3063): four levels, `trivial · low · medium · high`, each a signal-bar glyph
(`SignalLow`, `SignalMedium`, `SignalHigh`, `Signal`) beside the `labels.difficulty.*` label, as
`DifficultyIndicator` (`components/issues/DifficultyPicker.tsx`) renders it at the same commit.

## 20.1 The behaviour this Part draws to

Nothing here decides behaviour. **MOTIR-6133** (the plan-wire card) does:

- **The value set** is the work item's own: `trivial`, `low`, `medium`, `high`, or none. A plan
  proposal carries it in `proposedFields`, a `modify` patch sets, changes or clears it, and approve
  writes it onto the work item.
- **A container cannot carry one.** A difficulty on an epic or story proposal is refused on the
  merged kind, so the review never receives one to draw (§20.6).
- **MOTIR-6137** builds the pixels to this Part, including every copy key in §20.9.

## 20.2 Drawn against SHIPPED reality: what was rendered

Every card, list row, rail row and frame is the shipped component's own markup. A throwaway RTL dump
rendered `PlanItemNode`, `PlanProposalList`, `PlanChangeDiffFrame` (around a real `WorkItemNode`) and
`IssueQuickViewPanel` in proposal mode through the shipped `renderWithIntl` harness against
`planReviewItem` fixtures, at `main` `b22dc0a09`. Those files have not changed since then:
`components/planning/{ProposalPeek,PlanItemNode,PlanProposalList}.tsx`,
`components/issues/DifficultyPicker.tsx` and `IssueQuickViewPanel.tsx` all last change at or before
`b22dc0a09`. The new elements were spliced into that markup, and nothing else was hand-drawn. The
stylesheet is Tailwind's real output compiled from this document's class attributes only, with
`theme.css`'s `.style-vignette` rules removed and the utilities that the captions' prose alone
produced pruned. The harness was deleted before this asset landed.

**What the render settled (sheet 1).** The quick view already draws a leaf's Difficulty row in
proposal mode, in the leaf-only branch below Executor, as `DifficultyIndicator` or **None**. The
peek is therefore already correct once its payload carries the value: `ProposalPeek.proposedPayload`
hard-codes `difficulty: null` (the `// … MOTIR-6095` line), so today every proposal reads **None**
whatever the planner judged. The canvas card and the list row have no slot for it at all.

## 20.3 DECISION 1: an `add` card carries the value at the right end of its top row (sheet 2)

- **Where.** The node's top row is `OpBadge` on the left and an `ml-auto` cluster on the right (the
  stale badge, the status pill, the drill chevron). A proposed leaf `add` has no status and no
  children, so that cluster is empty today. The value goes there, after anything already in it.
  The **bottom slot is not used**, because spending it clamps the title to one line (Part XVII
  §17.2), and a difficulty is not worth half the title.
- **What.** The same glyph map and the same label as the item page (`DIFFICULTY_GLYPH`,
  `labels.difficulty.*`), in a compact form: `inline-flex shrink-0 items-center gap-1 text-xs
text-(--el-text-secondary)`, with the glyph at `h-3 w-3` (the node's own glyph size; the op badge
  uses `size-3`) and `text-(--el-text-faint)`, `aria-hidden`. `DifficultyIndicator` today renders a
  block `flex` at `h-4 w-4`. MOTIR-6137 either adds a compact variant to it or exports
  `DIFFICULTY_GLYPH`. It must not keep a second glyph map.
- **Named for a screen reader.** A visually hidden `Difficulty` (`sr-only`) precedes the glyph, so
  the value is announced as _Difficulty Medium_ and never as a bare _Medium_, which Priority also
  says.
- **Ink.** `--el-text-secondary` on the `add` frame's `--el-tint-lavender`, not `--el-text-muted`.
- **A `modify` card does NOT show the current value in its top row.** On the canvas a `modify` card
  says what CHANGES (its diff line, §20.5), and a committed card on the roadmap carries no
  difficulty either. Only an `add` draws its values on the card, because only an `add`'s card is
  the whole of what exists.

## 20.4 DECISION 2: NONE is the item page's empty rendering in the peek, and nothing on the card (sheet 3)

A plan written before the rule, or a pass that left the value out, still reaches review.

- **Peek.** The rail's Difficulty row reads **None** in `--el-text-secondary`: the quick view's own
  read-only empty state (`issueViews.none`), unchanged. It is never a blank row and never a missing row.
- **Card.** Nothing is drawn in the slot. An unlabelled _None_ on a card names nothing (the card has
  no field labels), and beside siblings that carry a glyph, the empty end of the top row is itself
  the visible absence.
- **List row.** Omitted. The facts line already omits every empty fact (points, minutes,
  repository), and this follows the same rule.

## 20.5 DECISION 3: a `modify` shows it as a field change, in the grammar `Story points` uses (sheet 4)

- **The field** is `difficulty` in `PLAN_ITEM_CHANGE_FIELDS`, emitted by `buildChanges` directly
  after `estimateMinutes` (the sizing group), and given a `FIELD_KEY` entry `difficulty`.
- **The values are the item page's LABELS** (`Low`, `High`), never the wire words (`low`, `high`).
  The reviewer reads the same word here as on the item page after approving.
- **Card, bottom slot**: the shipped `DiffLine`. The label **Difficulty**, the old value struck, the
  chevron, the new value, `+N more` when it is not the first change.
- **List**: the shipped `ChangeLines` grid. The uppercase **DIFFICULTY** label, the old value struck,
  `→`, the new value in `--el-text-strong`.
- **An empty side follows the shipped rule for every field, and this Part does not special-case it.**
  _Sets_ (`— → Medium`): an empty FROM is not drawn, so the card reads `Difficulty › Medium` and the
  list reads `DIFFICULTY  Medium`. _Clears_ (`Medium → —`): the TO reads **—**. The card's
  shorthand `— → medium` is this rendering.
- **Untouched**: no Difficulty change is emitted, so there is no row. The card's slot and the list's
  grid show only what did change (sheet 4d, `Story points 3 → 5`).
- **Peek**: the rail's Difficulty row shows the value approve will WRITE, with the shipped
  **changed** mark (`planReview.railChangedMark`) when the plan moves it. That takes two seams in
  `ProposalPeek`: the target overlay gains `difficulty` (as it has `storyPoints`), and
  `markFor('difficulty')` is passed to the row. Once MOTIR-6133 adds `difficulty` to the patch,
  `PATCH_KEY_RAIL_ROW` (total over the patch type) must map it to the `difficulty` rail row, so the denominator becomes **7**: _This plan changes 1 of the 7
  fields it can set._
- **The facts line** of a `modify` row carries the value approve will write (§20.7), exactly as it
  carries the points. A cleared value is omitted there.

## 20.6 DECISION 4: an epic or story proposal has no difficulty affordance anywhere (sheet 6)

A container cannot carry one (MOTIR-6133 refuses it on the merged kind), so nothing is drawn:
no slot on the card (its top row keeps the drill chevron), no fact on the list row, and no row in
the peek. The rail's leaf-only branch (Type, Executor, Difficulty) is absent, exactly as on the item
page, so Repositories is followed directly by Priority. No disabled control and no "not applicable"
text is drawn.

## 20.7 DECISION 5: at scale the value rides the LIST ROW, beside the points (sheet 7)

**Decided: the glyph and label sit in the row's facts line, directly after `listPoints`**
(`subtask · code · 3 pts · ▂▄▆ Medium · 45 min · motir-core`), not in the peek only.

**The reason.** The list is the body that says _exactly what is being approved_ (Part VIII §3), and
a difficulty is judged ACROSS siblings: is this one really High beside that Low? That question needs
the 40 values side by side, and peek-only would make it forty opens. Points and difficulty are read
together (size beside hardness), so they sit together. It costs no row height: the facts line is one
line at the pane's width and wraps where it must, as it already does.

**The markup.** The facts join becomes nodes joined by `·` rather than one string. The difficulty
node is the compact form of §20.3 plus `align-top`, so the inline-flex sits on the text line. A null
value is dropped like any other null fact. A container row never has one.

## 20.8 Which review-model field each drawn element reads

| element                                  | reads                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| the card's top-row value, the facts node | a NEW `difficulty: WorkItemDifficultyDto \| null` on `PlanReviewItemDto`, the value approve will write (`proposedValue`) |
| the diff line / change row               | `changes[]` entry `{ field: 'difficulty', from, to }`, both sides the LABEL, `null` for none                             |
| the peek's rail row                      | `QuickViewData.difficulty`: `item.difficulty` on an `add` (replaces the hard-coded `null`), the overlay on a `modify`    |
| the peek's `changed` mark                | `proposal.changedFields` includes `difficulty`                                                                           |
| the planning workspace chip (sheet 5)    | `changedFields(item)` via `FIELD_KEY.difficulty` → `planningWorkspace.conversation.diff.field.difficulty`                |

## 20.9 Copy: English and Chinese

| key                                                    | en                | zh        | note                                                          |
| ------------------------------------------------------ | ----------------- | --------- | ------------------------------------------------------------- |
| `labels.difficulty.{trivial,low,medium,high}`          | Trivial …         | 极简 …    | REUSED, the item page's own labels                            |
| `issueViews.difficulty` · `issueViews.none`            | Difficulty · None | 难度 · 无 | REUSED, the rail row as the quick view ships it               |
| `planReview.field_difficulty`                          | Difficulty        | 难度      | **NEW**: the diff line, the change row and the `sr-only` name |
| `planningWorkspace.conversation.diff.field.difficulty` | difficulty        | 难度      | **NEW**: the change frame's chip, lowercase like its siblings |
| `planReview.railChangeCount`                           | (unchanged)       |           | REUSED; its `{m}` becomes 7                                   |

Both catalogs change in the same PR, and a key in one alone is a parity failure.

## 20.10 a11y

- The glyph is decorative (`aria-hidden`, `--el-text-faint`), and the LABEL is the value.
  Difficulty is never carried by the glyph or by colour alone, and it has no hue (6097's rule:
  Priority owns the coloured pill for the same words).
- The card's and the list's value is prefixed by a visually hidden **Difficulty**, so it is never
  announced as a bare _Medium_.
- The change row's struck old value keeps the shipped `line-through` plus the arrow. The strike is a
  second signal, never the only one.

## 20.11 GIVES / TAKES: every key the mock names

`grep -n 'MOTIR-' design/ai-planning/plan-review--difficulty.mock.html` names seven keys:

- **MOTIR-6134** (this card): the asset's own key. It neither gives nor takes.
- **MOTIR-6095** (the story): **GIVES** it the review half of "the plan review shows it": the
  visible strings its acceptance walk (MOTIR-6142) asserts, namely a card's `Medium`, a list row's
  `3 pts · Medium`, a peek's **Difficulty** row, and a re-plan's `DIFFICULTY  Low → High`.
- **MOTIR-6053** (Part XIX): **TAKES** the review's structure, namely the node's top row and the
  bottom-slot rule, the list's facts line and its label/value grid, and the peek-as-quick-view
  premise. Nothing is given back; Part XIX's asset is not edited.
- **MOTIR-4182** (Part XIV): **TAKES** the proposal-mode rail, its `changed` mark and its
  `{n} of {m}` count line. It **GIVES** Part XIV a seventh settable rail row (§20.5).
- **MOTIR-6097** (the difficulty field's design): **TAKES** the glyph, the label, the None
  rendering and the leaf-only branch, in the four-level form on `main` at `b22dc0a09`. It gives
  nothing back.
- **MOTIR-6016** (the story that shipped the field): **TAKES** its premise, the shipped
  `DifficultyIndicator` and the quick view's Difficulty row, and the `difficulty: null` placeholder
  this Part replaces.
- **MOTIR-6133** (the plan-wire card): **TAKES** the value set and the container refusal (§20.1).
  It **GIVES** it nothing structural. The review only reads what the wire carries.

Not named in the mock, but owed: **GIVES MOTIR-6137** (the review renderer, `blocked_by` this card)
§20.3–§20.7's placements, §20.8's data seams and §20.9's two new keys.

## 20.12 What Part XX does NOT draw

- **Editing** a proposal's difficulty on the review. The review edits nothing new; a person's edit of
  a proposal's fields stays the existing proposal-edit surface, reached through its API door
  (MOTIR-6136).
- A **decided** plan's rendering. Part VI's treatments apply unchanged: the value stays where it is
  on an approved or declined card and row, and after approve it lives on the created work item.
- Any new entry point (see the access path above).

---

# Part XXI — the planning surface's left pane holds the plan page's List | Canvas (MOTIR-6184 · Story MOTIR-6155 — `plan-review--surface-views.mock.html`)

**The asset:** one DELTA mock, `design/ai-planning/plan-review--surface-views.mock.html`, holding only
the panels that change. No `.png` (AMENDMENT 4).

## 21.0 ⚠️ WHICH "Part XX" this Part cites, and why it never says the number

This Part amends **two** designs, and when it was written one of them was not in this file.

- **MOTIR-3234's Part VIII** (`plan-detail-list-view.mock.html`) — the pane header and the switch.
  That one IS here, and is cited by number.
- **MOTIR-6033's decide design** — the planning surface as a plan's DECISION surface, and the confirm
  bar's verbs, consequence line, decline band, held reason and stale alert. It was **published only**:
  evidence `cmueg6bue00kghwoikl5e6bxp`, approved 2026-09-23, carrying `plan-review--decide.mock.html`
  and a note fragment of its own.

**✅ RESOLVED — it is now Part XXII of this file (MOTIR-6190, `#3101`).** While this story was in
review, the bug this section was written to dodge was fixed: the decide design landed here, renumbered
from the `Part XX` its own result claims to **Part XXII**, with its sections `§20.x` kept as published.
So the ambiguous address is gone, and a citation of the decide design in this Part may now say
**Part XXII** and mean exactly one thing.

**Why the care was not pedantry, kept as the record of what went wrong.** That fragment numbered
itself `Part XX` and said it lands after Part XIX. It never landed. `Part XX` in this file is
MOTIR-6134's difficulty design (merged in the same merge-queue batch,
`moooon-B-V/motir-core#3082`), so for a stretch the number resolved to two different designs depending
on which document a reader had open — anything here that had said "Part XX §20.4" would have pointed
at difficulty chips. This Part refused the ambiguous address rather than guessing, and the index
table's own note above now carries the rule that prevents a repeat: **check the area's published
design results before taking the next number.**

## 21.1 What this COMPOSES and must not redraw

Almost everything. This Part adds no element and changes nothing inside one:

- the pane header and its `Segmented` **List | Canvas** switch — Part VIII §2, unchanged, including
  its `--el-surface` fill, its bottom hairline, its 44px height and `planReview.viewSwitchAria`;
- `PlanProposalList` — Part VIII §3, with Part XIII §7's clickable row;
- `PlanReviewCanvas` — Parts IX and XIII, including `arrivalLevel()` and the decided treatments of
  Part VI;
- `PlanChangeConfirmBar`, its decline band, its held reason and its stale alert — MOTIR-6033's design,
  Part XXII §20.4 and §20.5;
- the surface's Close + project bar and the audit-coverage banner's seam — `PlanningWorkspaceHost` as
  shipped, **including their COPY**: `planningWorkspace.close` and `escKey`, resolved from the
  catalogue rather than typed (21.11).

**The ONE thing it does not compose — and the one change this Part makes to a shipped surface — is
the footer SLOT.** The shipped host keeps a resting footer in it at all times; **21.8 hides the slot
entirely when there is nothing to show**, and moves the confirm bar from a sibling below the canvas to
an overlay on its bottom edge so that hiding it resizes nothing. That is a decision about the pane
this Part owns, not a re-drawing of anything inside the bar, whose every state is composed unchanged
(21.6).

**The canvas is a LABELLED REGION in the asset, not a redrawing** — the same treatment MOTIR-6033's
own mock gives it, and for the same reason: nothing inside it changes. This Part decides where the
component SITS.

## 21.2 Decision 1 — the component's pane header is a SECOND BAR, beneath the surface's Close bar

**The question.** Part VIII §2 decided a 44px pane header because _"the pane had no header … So a
header had to be DECIDED, not found."_ The planning surface's left pane is not in that position: it
already has a top bar — Close · `Esc` · the project name — that the plan page does not have. So either
the switch merges into that bar, or the component's own header stacks beneath it.

**The decision: the component's own 44px header, BENEATH the Close bar, composed whole.** Three
reasons, in the order they decided it:

1. **The component is mounted, not re-cut.** The whole story is that the surface and the plan page
   cannot disagree about a plan. A headerless variant for one host is a second shape of the pane
   header, and a second shape is the first thing that drifts. Merging would need exactly that.
2. **The Close bar is the OVERLAY's chrome, not the pane's control bar.** It carries Close, the `Esc`
   hint and the project name — the workspace's identity and its exit. The switch governs the BODY.
   Part VIII §2's own argument for placing the bar above the establish band ("the bar governs the
   BODY, and the band is not part of the body") is the same argument here one level up. The tell is
   already in the shipped code: the audit-coverage banner sits in the SEAM beneath the Close bar,
   full-bleed and unpadded (`design/audit-coverage` §1) — a bar that has a full-bleed banner hanging
   under it is not a control bar for the body below that banner.
3. **The fold cost is 45px and it is paid only while there is a plan.** The pane's chrome with a
   proposed plan is the Close bar (≈41px), this header (44px + 1px hairline) and the confirm bar
   (≈57px) — about 143px. With no plan the header does not render at all (decision 4), so the resting
   surface is byte-identical to what ships today, and the 45px arrives with the thing it controls.

**What is NOT decided here:** the Close bar's own contents. Nothing moves into or out of it.

## 21.3 Decision 2 — the DEFAULT view is the plan page's own rule, pinned at the first proposed read

**`defaultPlanView(review)`, unchanged** — Part IX §3's conditional rule: the canvas, and the LIST when
the plan's proposals straddle more than one container.

**Why the same rule and not a surface-specific one.** Part IX §3 reasons about the PLAN's shape, not
about the host: the list wins when the canvas cannot show the proposals on one level. That fact is a
property of the plan, and the surface is showing the same plan. A different default would mean one
plan opens as a list in one place and as a canvas in the other, which is the disagreement this story
exists to remove.

**PINNED, and re-seeded only when the plan changes.** The seed is taken once, at the first read in
which the plan is proposed, exactly as `PlanDetail` pins it at mount (Part XIII §6 / MOTIR-3262) and
for the same reason: a plan's item set can grow under a re-read, so recomputing per render would move
a reader between views while they are reading. It is re-seeded when the plan in hand changes identity
(a new `review.planId`), and by nothing else — not by a stale refusal, not by a revision, not by a
decision.

## 21.4 Decision 3 — the view is LOCAL to the open surface, and is NEVER written to the URL. CONFIRMED

The card asked for this to be confirmed or overturned. **Confirmed**, and the reason is stronger than
"the overlay owns four parameters":

- **The surface is an OVERLAY over whichever page the reader is on.** The address bar belongs to that
  page. `?view=` is not a free name — the plan page itself uses `PLAN_VIEW_PARAM`, so an overlay
  opened over `/plans/<id>` would be writing into a key the page underneath already reads.
- **Back already means one thing here, and it must keep meaning it.** The overlay routes Close, `Esc`,
  the scrim AND browser Back through one `requestClose()`, which is the seam the pending-proposal
  guard intercepts. A view switch that pushed history would make Back mean "go back to Canvas"
  sometimes and "close the workspace, and maybe ask about your proposal" other times, decided by
  something the reader cannot see.
- **Nothing is lost.** The plan page keeps the URL contract MOTIR-3239 / MOTIR-3434 gave it, because
  the view stays CONTROLLED by the host: the page holds it in the URL, the surface holds it in local
  state, and the component holds it in neither.

**So a switch on the surface leaves the query string byte-identical**, and that is drawn as a
criterion rather than left as an intention.

## 21.5 Decision 4 — the access path: no new door, and the switch APPEARS when the plan becomes proposed

**The surface is reached exactly as it is today** — _Plan with AI_ on a work item, a Plans row, or a
To-approve row (Part XXII §20.2). This Part adds no entrance.

**What it adds is a moment.** The switch is not a control the reader goes looking for; it arrives with
the plan:

| when                                | the left pane                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **no plan yet** (conversation only) | `PlanChangeCanvas`, exactly as shipped. **No pane header, no switch** — there is nothing to list. Footer slot: the resting footer. Sheet 1 panel A.                                               |
| **`generating`**                    | NOT this Part's. The live-drawing story (MOTIR-6158) owns the pane while the plan is being written, and hands over to this component the moment the plan becomes proposed. Nothing here draws it. |
| **proposed** (`planned` or `stale`) | the pane header arrives with the switch, and the body is `PlanProposalList` or `PlanReviewCanvas`. Footer slot: the confirm bar. Sheet 1 panel B, sheet 2.                                        |
| **decided**                         | the component stays, on the view the reader was on, in Part VI's decided treatment. The bar leaves with the proposal and the resting footer takes the slot back. Sheet 6.                         |

## 21.6 The confirm bar is IDENTICAL under both views — and the bands belong to the BAR

**The verbs do not move when the view changes.** Sheet 2 draws the proposed pair, sheet 4 the held and
stale pairs; in each the pane header and the bar are the same element and only the body differs. The
bar is the pane's FOOTER SLOT, and the switch governs the body above it.

**Every band is the bar's, not either view's:**

- **Decline pressed** — the `confirming` band stacks above the bar and the verb group steps aside.
  Drawn over the LIST (sheet 3) precisely because MOTIR-6033 drew it over the canvas; one design
  showing it over each body is what makes "it belongs to the bar" unambiguous.
- **Held** — both verbs disabled, not removed, the held reason in place of the consequence line.
  **The switch stays LIVE: reading is never held.** Sheet 4 panel A.
- **Refused as stale** — the `role="alert"` band directly above the verbs it refused; the body re-reads
  to the new version and **the view does not move**. Sheet 4 panel B.
- **See but not decide** — no verbs at all, not disabled ones. The switch and both bodies are
  untouched, which is the point: a reader who may not decide may still read the plan either way.
  Sheet 5.

**An EMPTY proposed plan** (sheet 7) draws whatever the shared component already draws, composed. The
switch still renders, because there IS a plan.

## 21.7 The canvas LEVEL survives a round trip, and so does the composer draft

**A note, not a panel — it is a behaviour and a still frame cannot show it.** Canvas → List → Canvas
returns the reader to the level they were on, not to the arrival level. On the plan page the canvas
unmounts under List and that is correct there (its suite asserts it), so the surface asks for the
behaviour as an **opt-in** rather than changing the page: the canvas stays mounted, hidden and `inert`,
and the level survives because the component never unmounted.

**The composer draft is untouched by all of this.** It lives in the RAIL, which is the other pane; a
switch in the left pane cannot reach it. Drawn nowhere, asserted everywhere.

## 21.8 When there is NOTHING to show, the footer HIDES — and the bar OVERLAYS the canvas

**Yue's decision, this review round: if there is nothing to show in the footer, the footer should be
hiding.** With no proposal in hand there is no footer slot at all. The canvas runs to the pane's
bottom edge.

**Why the foot has nothing to say.** The rail on the right IS the planner. Before a plan is proposed
it is where the conversation is happening and where the planner says where it has got to — so a line
in the foot restating that is a second voice for one fact, at the far side of the surface from where
the reader is looking. And once it has nothing to say, an empty box holding its own height is worse
than no box: it is chrome that exists to be invisible.

### The structural change that makes hiding SAFE — the bar stops being a sibling

Hiding the slot cannot be done by itself, and this is the part a build must not skip.

The confirm bar is today a `shrink-0` sibling BELOW the `min-h-0 flex-1` canvas box. The canvas
anchors three control clusters to the bottom of that box — the engine's zoom + fit
(`bottom-4 left-4`, `PlanningCanvas.tsx`), LOCATE (`bottom-4 left-[8.25rem]`,
`ProjectRoadmapCanvas.tsx`) and full-screen (`right-3 bottom-4`). So a slot that comes and goes
resizes that box by the bar's full height on every proposal, and all three clusters slide with it.
That is **bug MOTIR-1815**, and the fix that shipped was to stop the box changing size by keeping a
resting footer in the slot at all times.

**This Part replaces that fix rather than reverting it**, and the replacement is strictly better:

- **The canvas box is ALWAYS the full height of the pane below the header.** It has no footer sibling,
  ever.
- **The confirm bar OVERLAYS its bottom edge** when there is a proposal, instead of sitting under it.
- **The three clusters carry a permanent bottom inset of the bar's height**, so they sit above the
  strip the bar will occupy whether or not the bar is up.

The result is that **nothing resizes and nothing moves, in either direction** — which is more than the
old fix achieved, because the old fix held the box constant by always spending the space. Here the
space is only ever _drawn into_ when there is something to draw.

**Drawn in sheet 1 panel A**: the dashed strip at the foot of the canvas is the region the bar will
overlay, and the two control clusters sit above it. When resting, that strip is canvas — the reader
sees the roadmap, not a box.

### What a build must get right

1. **Do not make the canvas box's height conditional on the proposal.** If `PlanChangeCanvas` /
   `PlanProposalViews` grows and shrinks, MOTIR-1815 is back and no guard in the design lane will
   see it. The box is constant because it is always full; the bar floats.
2. **Inset the clusters permanently, and derive the inset** from the bar's own box rather than pinning
   a number — the same discipline the shipped resting footer already keeps: _"a magic `min-h` would
   drift the moment the bar's own content changed and re-introduce the jump this slot exists to
   remove."_ The `57px` in this asset's board chrome is a drawing convenience and is **not** the
   specification.
3. **Retire the two catalogue keys with their only consumer.** `planningWorkspace.footerRestingTitle`
   and `footerRestingBody` are rendered in exactly one place, `PlanningWorkspaceHost.tsx`
   (`git grep -n "footerRestingTitle" -- components app` → one file). Removing the resting footer
   orphans both, in `messages/en.json` **and** `messages/zh.json`. They go in the same change; a dead
   key that still reads as live copy is how a later card puts the line back.
4. **A test asserts the canvas box is the same height with a proposal and without one**, and that the
   clusters are at the same offset in both. That is the assertion MOTIR-1815 never had — its fix was
   protected by a visible footer rather than by a measurement, which is why emptying that footer was
   able to look safe.

**What this does NOT change.** The confirm bar itself, in every one of its states — the verbs, the
consequence line, the decline band, the held reason, the stale alert — is untouched (21.6). This
decision is about the slot, not its content: where the bar sits, and what happens when there is no bar.

## 21.9 Token and shape roles

Nothing new. Every element in the asset is a shipped component's own markup or the surface's own
chrome, so the roles are those components' — Part VIII §2's table for the header and the switch,
Part XXII §20.8 for the bar and its bands.

The asset's two additions are its BOARD chrome, which paints only through `--el-*`
(`--el-text-secondary` / `--el-text-strong` / `--el-text` for ink, `--el-canvas` / `--el-surface` /
`--el-page-bg` for surfaces, `--radius-card` for the board), and one presentation-free
`.seg-ic { font: inherit }` declaration. That class is a MARKER the shipped `Segmented` puts on an
option's glyph and styles with utilities on the same element — nothing in the app declares a rule for
it — and it is declared here only because this asset carries the real markup and
`tests/design-mock-utility-correspondence.test.ts` direction (D) rules on a class carried with no
declaring selector. The `.seg button .seg-ic` rules in older assets are shims for hand-drawn
segmented controls this asset does not have.

## 21.10 a11y

Inherited, and worth stating because the switch is the one control this Part places:

- the switch is the shipped `Segmented` — a labelled `role="group"` whose options are real `<button>`s
  carrying `aria-pressed`, so it is keyboard-operable and announced as a toggle;
- its accessible group name is `planReview.viewSwitchAria`, the plan page's own key. **No new string is
  introduced by this Part**, in either catalogue;
- the stale band keeps its `role="alert"`, so a refusal is announced whichever body is showing;
- the held state DISABLES the verbs rather than removing them, so their absence is never silent — and
  the switch is deliberately left enabled, because nothing about reading is held.

## 21.11 How the asset was produced

Stated because criterion 2 asks for it, and because a claim to compose shipped markup is worth being
checkable:

- Every pane header, list body, confirm bar, decline band, held bar and stale bar in the asset is the
  **real components' own DOM**, rendered through `tests/helpers/renderWithIntl.tsx` in happy-dom on
  `origin/main` @ `d0976c0ab` and emitted verbatim — real `Segmented`, real `PlanProposalList`, real
  `PlanChangeConfirmBar`, real `en` catalogue strings. Not a transcription.
- The Close + project bar and the resting footer are copied verbatim from
  `components/planning/PlanningWorkspaceHost.tsx` at that commit — its inline chrome is not a
  component that can be rendered on its own, so its MARKUP is copied and **its TEXT is resolved from
  `messages/en.json`**, never typed.

  ⚠️ **That last clause is a correction, and it is worth reading.** The first version of this asset
  copied those class strings correctly and then TYPED the words: the resting footer read
  _"Ask for a change"_ / _"Asking writes nothing — you will see the plan before anything is created."_
  where the catalogue says `planningWorkspace.footerRestingTitle` / `footerRestingBody` —
  _"Roadmap — as saved"_ / _"Nothing proposed. The conversation has changed nothing."_. The invented
  pair was worse than merely wrong: it read as a call to action, which is precisely what that footer
  must not do (`PlanningWorkspaceHost.tsx`: _"deliberately quiet … so it never competes with the gate
  or reads as something to act on"_). **A mock is product COPY**, in the register it ships in, and a
  later card building to this asset would have transcribed it. It shipped in a published result and
  was caught by a person reading the board.

  Two things changed as a result. The asset's own build resolves every product string through a
  catalogue lookup that THROWS on a missing key, so a string it cannot resolve fails rather than
  ships. And **`tests/design-surface-views-chrome-copy.test.ts`** now reads this asset and
  `messages/en.json` together and requires each of the four chrome strings verbatim, hard-coding
  none of them — the same shape as `design-lesson-phase-chips` (MOTIR-5107) and
  `design-github-development-copy` (MOTIR-5152). It is in the design lane, because a `design/*` pull
  request editing this mock skips every app lane and is the one that must not skip this. Every other
  guard in that lane was green over the invented copy: they rule on colour, shape, structure and dead
  rules, and none of them reads a string.

- `PlanReviewCanvas` and `PlanChangeCanvas` are labelled regions (21.1).
- The first stylesheet is the project's real Tailwind v4.3.0 output, compiled over this document's own
  class attributes with `@motir/design-system/theme.css` — the token layer is generated, not
  hand-copied. Four authored rules for a component this asset does not draw
  (`.style-vignette > .sv-canvas`) were dropped, because a rule nothing carries is what MOTIR-4150 read
  a measure off and direction (B) rules on it at zero.
- **No pixel render of the assembled board was taken.** The sandbox this was authored in has no
  browser system libraries and no root, so `scripts/render-design-mock.mjs` could not run. It is
  optional and publishes nothing. What DID render the finished asset are the guards that use
  happy-dom — `design-dark-parity`, `design-state-ink-contrast`, `design-ink-contrast` and
  `design-mock-utility-correspondence` — and all 228 specs in the design lane are green over it.

## 21.12 GIVES / TAKES

Over every `MOTIR-<n>` the new mock and this Part name:

- **MOTIR-6155** (the story) — neither. It is the container.
- **MOTIR-6185** (the extraction) — **GIVES** nothing and **TAKES** nothing. It is a pure lift of the
  plan page's own JSX, decided before this design and unaffected by it; this Part only requires that
  the result be mountable whole, which is what it already is.
- **MOTIR-6186** (the mount) — **GIVES** it all four decisions as its spec: where the header sits
  (21.2), the default and its pinning (21.3), local-not-URL (21.4), and the state table (21.5–21.7).
  It takes nothing from it.
- **MOTIR-6033** (the decide design) — **TAKES** the confirm bar, its verbs, its consequence line and
  all four of its bands, composed unchanged. **Nothing is given back and its asset is not edited.**
  This Part adds a second body above that bar and does not touch the bar.
- **MOTIR-3234** (Part VIII) — **TAKES** the pane header and the switch, composed unchanged, and
  extends the REASONING behind its placement to a host that already has a top bar (21.2). Part VIII's
  own decision for the plan page is unchanged.
- **MOTIR-4016 / MOTIR-4017** (Part XIII) — **TAKES** the derived default's pinning and the clickable
  list row. Unchanged.
- **MOTIR-3162** — **TAKES** the property that a review survives its decision, which is what lets a
  decided plan keep the view the reader was on (21.5). Unchanged.
- **MOTIR-3239 / MOTIR-3434** — **TAKES** the plan page's URL contract by leaving it alone: 21.4 keeps
  the view host-controlled precisely so the page's `?view=` behaviour is untouched.
- **MOTIR-6158** (the live-drawing story) — neither. 21.5 names the handover and draws nothing of it.
- **MOTIR-6154 / MOTIR-6159 / MOTIR-6160** (the landing story) — neither. Where the canvas ARRIVES is
  theirs; this Part draws the canvas as a region and says nothing about its level.
- **MOTIR-6134** (Part XX, difficulty) — neither, and 21.0 is the only reason it is named: its Part
  number collided with the number MOTIR-6033's published fragment used.
- **MOTIR-6190** — the bug 21.0 raised, now FIXED (`#3101`): it landed the decide design here as
  Part XXII, so this Part cites it by number rather than by evidence id. Neither gives nor takes.
- **MOTIR-4150 / MOTIR-4687** — neither. Named in 21.11 as the reason a dead rule is dropped.

## 21.13 What Part XXI does NOT draw

- **Anything inside the list, the canvas, the confirm bar or the decline band.** All approved and
  shipped; composed only.
- **The `generating` pane** — MOTIR-6158's.
- **Where the canvas arrives, and the move when a target settles** — MOTIR-6154's, drawn by
  MOTIR-6159.
- **The decide verbs themselves, the held reason's wording, the stale sentence and the see-only line**
  — MOTIR-6033's, quoted but not re-decided.
- **The rail**: the transcript, the composer and the review block are untouched, and the composer
  draft's survival (21.7) is a property of NOT touching them.
- **The plan page.** It is unchanged, and its own suites are the assertion of that.
- **Any new string**, in either catalogue.

# Part XXII — The PLAN-APPROVAL gate: the To-approve row, the planning surface as its DECISION surface, and the hand-off before generation (MOTIR-6033 · Story MOTIR-6012, DATED 2026-09-23)

> **Published as "Part XX" and renumbered on landing (MOTIR-6190).** This Part is MOTIR-6033's approved
> design result, evidence `cmueg6bue00kghwoikl5e6bxp` (published 2026-09-23), landed here verbatim
> except for its numbering. Its result calls it **Part XX** with sections **§20.0–§20.11**, but Part XX
> of this file is MOTIR-6134's difficulty design and Part XXI is MOTIR-6184's published design, so it
> lands as **Part XXII**. Every section keeps its number after the dot: the result's §20.N is §22.N
> here, and its own cross-references are rewritten to match. References to `§ 20` (with a space) are
> the workbench notes' § 20 and are unchanged.
>
> **Its two mocks are not mirrored in this tree.** `design/ai-planning/plan-review--decide.mock.html`
> and `design/workbench/approvals-row--plan.mock.html` are read from the design result on MOTIR-6033
> (`get_design MOTIR-6033`), which is the source of truth (`docs/decisions/design-result.md`
> AMENDMENT 5 Q1). The same result carries the § 29 pointer text for `design/workbench/design-notes.md`,
> which that file does not hold yet.

**The assets:** two DELTA mocks, with no `.png`.

- `design/workbench/approvals-row--plan.mock.html` is the row. It amends
  `design/workbench/approvals-row.mock.html` (§ 20) as the shipped `ApprovalRow` renders it after
  § 28's plain-words sentence.
- `design/ai-planning/plan-review--decide.mock.html` is the decision surface and the hand-off.

**This Part is the spec of record for both.** The story ships them together, and one reader should
not need two files to review it. The workbench area's § 29 is a pointer back here.

**What it amends, by path.** None of these files is edited:

- `design/ai-chat/planning-workspace.mock.html`: the two-pane shell.
- `design/ai-chat/plan-change-conversation.mock.html` sheet 4: the review as a diff on the canvas,
  the confirm bar, and the rail's review block.
- `design/ai-chat/planning-workspace--resume.mock.html` panel 5 (MOTIR-6019 §19.8): the reopened
  line.
- `plan-detail-refined.mock.html` (Part XIII): `PlanReviewRail` and its decision footer, which holds
  the rail's existing approve CTA.

**Contract:** `docs/decisions/approval-gates.md` §11 (MOTIR-6031): §11.3 the stamp, §11.4 the verbs,
§11.5b the decision surface, §11.5c the hold, §11.6 routing and §11.7 raise and supersede. This Part
decides only what §11.11 leaves to it: the row's words and the surface's words and layout.

## 22.0 Drawn against SHIPPED reality

Both mocks are composed from the components at base `91982c72a`. The class strings were copied from
the source, not from older mocks:

- `components/approvals/ApprovalRow.tsx`: the row, its sentence, details, waited and decide cells,
  `StatePill` and the narrow stack.
- `app/(authed)/workbench/_components/ApprovalsList.tsx`: the header band.
- `components/planning/PlanChangeConfirmBar.tsx`: the canvas bar.
- `components/planning/PlanChangeRail.tsx`: the header, bubbles, act rail, review block,
  `planning-reopened-session` line and system marker.
- The composer, exactly as MOTIR-6019's published mock emits it.
- `components/planning/PlanReviewRail.tsx`: header, history and the pinned footer.
- `components/approvals/ApprovalGateControl.tsx`: the `confirming` band.
- The design-system `Button`, `Pill`, `FormField` and `Textarea` recipes.

Each mock's first stylesheet is the project's real Tailwind v4.3.0 build (`tailwindcss` +
`@motir/design-system/theme.css`), compiled over that mock's markup only. The token layer is
generated, not hand-copied. The second stylesheet is board chrome, and it names colour only through
`--el-*`. Glyphs come from `lucide-react` 1.16.0's icon nodes. **The plan-review canvas is not
redrawn.** It is a labelled region, because nothing on it changes.

## 22.1 ⚠️ THIS KIND RENDERS NO PORT — and it is not decided in the approval overlay

**`plan_approval` renders NO port and is NOT decided in the approval overlay** (`approval-gates.md`
§11.5b). Every other kind opens `?approval=<key>&approvalKind=<kind>` over the tab and is decided in
the universal frame (`design/work-items/design-notes.md` ~6521, `design/workbench/design-notes.md`
§ 22). A plan is decided on the PLANNING SURFACE instead. The reviewer needs the plan and the
conversation that can change it, and a port can host the first but not the second.

So neither mock draws the frame. **This is deliberate, and it is not a gap:**

- Do not add a plan port.
- Do not add a `plan_approval` arm to `withApprovalOverlay`.
- Do not "fix" the missing frame.

Routing, the record, the stamp and the one decide door are exactly the other kinds'. Only the
surface differs.

## 22.2 The ACCESS PATH (`approvals-row--plan` Panel 4 · `plan-review--decide` Panels 1 and 9)

| from                                                 | how                                                                                                                                                                                                                                                                                                                                   | to                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **To approve → a plan row** (the plan has a session) | A plain primary click on the row or its **Review** button `shallowPush`es the **planning overlay's** address over the tab. With a target: `?tab=approvals&plan=contextual&planFrom=work-item&planItem=<target>&planSession=<id>&planVia=approvals`. Without one: `…&plan=project&planFrom=project&planSession=<id>&planVia=approvals` | The planning surface at that conversation, with the plan on the canvas and **Approve · Decline** in place (decide Panel 2). **Close** strips the overlay's parameters and lands on `/workbench?tab=approvals` exactly. |
| **To approve → a plan row** (no conversation)        | A real navigation to `/plans/<id>`. No conversation means: backfilled, an agent-authored MCP plan whose session has no turns, or a `cadence` plan (§11.5b).                                                                                                                                                                           | The plan's own page, which says why, with the same two verbs (decide Panel 8).                                                                                                                                         |
| a modified, middle or secondary click on the row     | The row's `href` is `/plans/<id>`: the shipped `usePeekRowClick` contract, with the plan page where other kinds have the card.                                                                                                                                                                                                        | The plan page, in a new tab.                                                                                                                                                                                           |
| **the planning surface**                             | Approve or Decline, in place (Panels 2–3).                                                                                                                                                                                                                                                                                            | The same surface, decided (Panel 6). The row settles in To approve (§ 20's rule).                                                                                                                                      |
| a stale `?approval=` link to a plan gate             | The overlay does not render a frame with no port. It sends the reader to the first row of this table (§11.5b, MOTIR-6037).                                                                                                                                                                                                            | The planning surface.                                                                                                                                                                                                  |

**⚠️ ONE NEW ADDRESS PARAMETER, `planVia`.** Since MOTIR-6024, the shipped rail prints _Reopened
from the Plans page · …_ whenever `planSession` is present (`PlanChangeRail`, `state.reopened`). A
person arriving from To approve would read a false sentence. So the To-approve row adds
**`planVia=approvals`**:

- Its only reader is the reopened line's copy (22.5).
- It is read only with `planSession`.
- Absent, or any other value, means the Plans page, so every shipped link keeps its meaning.
- **Close strips it with the other five.**

It belongs in `design/ai-chat/design-notes.md`'s address table, which three files agree on. This
publish carries one note file, so the row is specified here and the table row is owed by MOTIR-6037
(22.11 flag 2):

| parameter     | carries                                                                                                                                   | values                | read by                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------ |
| **`planVia`** | The entrance a NAMED session was reopened from, so the reopened line tells the truth. Read only with `planSession`. Absent means `plans`. | `plans` · `approvals` | the rail's reopened line |

## 22.3 The ROW (`approvals-row--plan.mock.html`)

It is `ApprovalRow` with the shipped columns, `APPROVALS_GRID_TEMPLATE`, header band and narrow
stack. What is new is one kind's glyph, sentence, details and two states.

- **Glyph:** lucide `sparkles` in `--el-accent-on-surface`, `aria-hidden`. It is the Motir-AI mark
  the Plans nav and _Plan with AI_ already carry, so a reader knows it. The words carry the meaning.
- **The leading line (DECIDED, Panel 1).** It says what the plan is ABOUT and never leads with the
  gate kind (§ 28):

  | the plan has                       | the sentence                          | key cell                                     | title door                                                                        |
  | ---------------------------------- | ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
  | one target                         | _Plan for_ **{target title}**         | the target's key                             | the target's title is the shipped title door (its quick view, `usePeekRowClick`)  |
  | several targets (`targetKeys` > 1) | _Plan for_ **{first target's title}** | `{first key} +{n}`, every key in its `title` | as above, on the first                                                            |
  | no target, a title                 | _Plan —_ **{plan title}**             | none                                         | **none**: a plan has no quick view, so its title is plain text under the row door |
  | no target, no title                | _Plan for_ **{project name}**         | none                                         | none                                                                              |

  The row never shows a blank, never shows a bare plan id, and never names a card the plan does not
  target. The target set is the plan's session's `targetKeys`, in stored order.

- **Details:** `{n} proposed items · {author}`. The author is _written by Motir AI_, _written by
  {harness}_ or _planned automatically_ (for a cadence plan). It shows the author rather than the
  requester because the gate is routed to the requester (§11.6), so the requester is ordinarily the
  person reading. The cell's `title` carries the plan title.
- **Waited:** the gate's `createdAt`, as for every kind.
- **Decide cell:** the shipped **Review** button, whose door is the planning surface (22.2).

**States in To approve (Panel 2):**

| state                | when                                                           | decide cell                                                                                              |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| awaiting             | `awaiting`, `canDecide`, no lease                              | **Review**                                                                                               |
| **being rewritten**  | `awaiting`, with `held.reason = 'revision_in_flight'` (§11.5c) | `Pill severity="info"` (sky) reading **Being rewritten**. No button, no verb. The whole row still opens. |
| see but not decide   | `awaiting`, `!canDecide`: the requester lacks `ai:decide_plan` | the shipped **Awaiting** pill                                                                            |
| settled approved     | decided here or in the surface                                 | `Approved` (mint). § 20's settle-in-place rule is unchanged.                                             |
| settled **declined** | the NEW terminal state (§11.4)                                 | **`Declined`**: `Pill severity="warning"` (peach), like every refusal a person pressed                   |

**⚠️ _Being rewritten_ is not § 26's _held_ row.** § 26's `section: 'held'` is a row that LEFT the
awaiting set (_Decided elsewhere_). This one never left it: the gate stays `awaiting`, and only its
verbs are refused. The code must not reuse `section: 'held'` for it. Sky is the tint the plan rail's
in-flight band already spends, and no plan status spends it.

**Decided records, in the Approvals room (Panel 3):**

- **Declined with a reason:** the reason's first line replaces the details (MOTIR-6075's
  `RefusalReasonCell`).
- **Declined without one:** _Declined without a reason · on {version}_.
- **Withdrawn**, with the shipped colourless pill, gets one sentence per cause (§11.7):
  - `plan_stale`: _Work this plan changes was finished, so the plan went out of date and this
    question was withdrawn._
  - `plan_discarded`: _Every proposal in the plan was withdrawn, so the plan ended and this question
    with it._

  Neither may fall back to `withdrawn`'s or `pulled_back`'s words.

**Which field each element reads.** This is what MOTIR-6034's DTO owes, because `workItem` is null
for this kind:

| element                            | field                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| sentence form + title + key cell   | the plan's session's `targetKeys` (+ each target's title), else `Plan.title`, else the project name |
| details                            | the plan's proposal count · `authorSource` / `authorHarness` / `origin`                             |
| the door                           | `Plan.id` (href), `Plan.sessionId` + whether that session has turns (overlay vs page)               |
| being rewritten                    | the gate DTO's `held` (§11.5c)                                                                      |
| waited · state pill · record lines | unchanged: `waitingSince` · `state` · `refusalReason` / `supersedeCause`                            |

**Code note for MOTIR-6037.** `ApprovalRow`'s `SENTENCE_KEY` is total over the kind. `plan_approval`
cannot be one `workbench.approvals.sentence.*` key, because it has four forms. It takes its own
branch that reads `approvalGate.planApproval.row.*`. The row's `href` and door are `/plans/<id>` and
the planning overlay, never `/items/<key>` and `withApprovalOverlay`.

**Narrow (Panel 5)** is § 20's reflow unchanged. The frame words _Plan for_ and _Plan —_ never
truncate; the title does.

## 22.4 The DECISION SURFACE (`plan-review--decide.mock.html` Panels 2–3, 8)

**Where the two verbs sit (DECIDED).** They are the controls the surface already has, re-pointed at
the one decide door (MOTIR-6038). **Nothing is added beside the existing Approve:**

- **The planning surface** already decides a plan in two places. They stay:
  - the canvas's **confirm bar** (`PlanChangeConfirmBar`), which is the gate;
  - the rail's **review block** (`plan-change-review`), which mirrors it.

  When the plan has an awaiting gate, both read **Decline** (ghost, left) and **Approve** (primary,
  check, right), the order the bar already has. The shipped _Discard_ / _Approve changes_ (zh
  _放弃_ / _确认变更_) are the words for a proposal nobody has been asked about. For a gated plan they
  become the gate's verbs, so the planning surface and the plan page say the same two words.

- **The plan page** (`PlanReviewRail`) needs nothing moved. Its existing CTA, _Approve — add {n}
  items to your backlog_, IS the gate's Approve. Its ghost _Decline_ IS the gate's Decline.

**The consequence line** replaces _Nothing is saved until you approve_ on the bar's second line, and
it appears under _Nothing saved yet_ in the review block: _Approving adds these to your backlog.
Declining ends the plan and changes nothing._

**⚠️ There is NO _Request changes_, anywhere** (§11.4). A plan is changed by talking to the planner,
which writes a new version of the same plan. A verb that recorded a refusal and then waited would
wait for something only the conversation can cause. The composer is on the same surface, directly
below. The door refuses `request_changes` on this kind by name, so no surface may offer it.

**Decline confirms once (Panel 3).** It uses the approve language's own `confirming` band from
`ApprovalGateControl`: an inline band over the verbs, never a modal.

- On the bar, the band stacks above it and the bar's verb group steps aside. In the rail, the band
  replaces the review block's verbs.
- Title: _Declining this plan will:_. Three consequences: _End it — it cannot be approved
  afterwards._ · _Leave your backlog exactly as it is._ · _Take it out of To approve._
- The shipped `FormField` + `Textarea` asks _Why are you declining it?_, with the helper
  **_Optional. It is kept with the decision._**
- **The reason is OPTIONAL**, a stated departure from §10a (§11.4). _Yes, decline_ is live with the
  field empty, and there is no required-error state. The note is stored as `noteMd` when given.

**Approve asks nothing.** One press, as the plan's Approve always has; its consequence line sits
beside it. The shipped stale-warning confirm for approving with stale proposals is unchanged.

## 22.5 Every STATE of the surface

| state                                | what the reader sees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | panel |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **ready (reopened from To approve)** | MOTIR-6019's reopened line in its slot, naming THIS entrance: _Reopened from To approve · started by you · last active {when}_ (or _started by {name}_). The transcript opens at its latest turn (shipped). The plan is on the canvas; both verbs are live, with the consequence line.                                                                                                                                                                                                                | 2     |
| Decline pressed                      | the confirm band (22.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 3     |
| **held**: the planner is rewriting   | Both verbs are **disabled, not removed**. They come back on this surface the moment the lease ends. The reason replaces the consequence line: _Motir AI is writing a new version of this plan. Approve and Decline come back when it finishes — it stays in To approve meanwhile._ The act rail streams, and the composer is disabled, as shipped.                                                                                                                                                    | 4     |
| **refused as stale**                 | `APPROVAL_GATE_STALE_SUBJECT`. A `role="alert"` band directly above the verbs it refused, on `--el-tint-yellow` (the plan rail's _changed under you_ tint, not danger): **_This plan changed while you were reading it._** _Nothing was approved or declined. The canvas now shows the new version — look it over, then decide again._ The canvas and counts are re-read, and the verbs are live against the new stamp. The same sentence appears in the review block when the press came from there. | 5     |
| decided: approved                    | the shipped after-approve turn (`planningWorkspace.conversation.approved`). The bar leaves with the proposal.                                                                                                                                                                                                                                                                                                                                                                                         | 6     |
| decided: **declined**                | the shipped centred system marker: _You declined this plan. Nothing in your backlog changed, and it has left To approve._ It is not a planner turn and not an alert: a person ended the question.                                                                                                                                                                                                                                                                                                     | 6     |
| decided by somebody else first       | `approvalGate.refusal.alreadyDecided`, verbatim                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 6     |
| see but not decide                   | **No verbs at all**, not disabled ones (the frame's state-B rule). A lock glyph and _Waiting on {name} to approve or decline this plan. Deciding a plan needs permission to decide plans._                                                                                                                                                                                                                                                                                                            | 7     |
| **no conversation → the plan page**  | `PlanReviewRail` gains one notice (the reopened line's shape, `message-square-text` glyph) naming the cause, then _Approve or decline it here — or ask Motir to change it below._ The page HAS a composer (Part XII), so the notice never says there is nothing to talk to, only that there is no conversation to return to. Same verbs, same confirm band.                                                                                                                                           | 8     |

## 22.6 The HAND-OFF before generation (Panel 9)

**The message.** When the conversation settles and the run starts writing, the planner says so in
its own turn. It is a keyed assistant bubble, like the shipped `lockedNote`, so the words are the
catalogue's and not the model's:

> _I have what I need — I'm writing the plan now. You don't have to wait here: close this whenever you
> like, and the plan will be waiting for you in **To approve**._

**To approve** is a link to `/workbench?tab=approvals`. A revision gets its own form:

> _I'm writing a new version of this plan. You can close this — it stays in **To approve**, and you
> can decide once I'm done._

The act rail follows it, as shipped.

**Leaving.** Close, Esc or Back closes the overlay.

- **No close guard opens while the plan is being written, or once it is `planned` with an awaiting
  gate.** The run is a server job and continues. A `planned` plan is kept and waits in To approve.
- The shipped guard's body (_"Nothing is saved until you confirm. Closing now discards them."_) is
  false for a gated plan. It must not be shown for one (22.11 flag 1).

**Coming back.** When the plan reaches `planned`, the row is raised and appears in To approve. § 26:
a nudge ADDS rows. The row returns the person to the surface in its ready state, which carries the
reopened line (22.5).

## 22.7 Copy — `messages/en.json` and `zh.json`

Every new string sits under **`approvalGate.planApproval`**, except three that belong to namespaces
total over an enum: the state pill, the two withdrawal causes and the kind label. Those join their
existing maps.

| key                                                  | en                                                                                                                                                                         | zh                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `approvalGate.planApproval.row.targeted`             | Plan for <title>{name}</title>                                                                                                                                             | <title>{name}</title>的计划                                                                                 |
| `approvalGate.planApproval.row.untargeted`           | Plan — <title>{name}</title>                                                                                                                                               | 计划 — <title>{name}</title>                                                                                |
| `approvalGate.planApproval.row.untitled`             | Plan for <title>{project}</title>                                                                                                                                          | <title>{project}</title>的计划                                                                              |
| `approvalGate.planApproval.row.moreTargets`          | +{count}                                                                                                                                                                   | +{count}                                                                                                    |
| `approvalGate.planApproval.row.details`              | {count, plural, one {# proposed item} other {# proposed items}} · {author}                                                                                                 | {count} 个建议工作项 · {author}                                                                             |
| `approvalGate.planApproval.row.author.motir`         | written by Motir AI                                                                                                                                                        | 由 Motir AI 撰写                                                                                            |
| `approvalGate.planApproval.row.author.harness`       | written by {harness}                                                                                                                                                       | 由 {harness} 撰写                                                                                           |
| `approvalGate.planApproval.row.author.cadence`       | planned automatically                                                                                                                                                      | 自动规划                                                                                                    |
| `approvalGate.planApproval.row.rewriting`            | Being rewritten                                                                                                                                                            | 正在改写                                                                                                    |
| `approvalGate.planApproval.row.rewritingTitle`       | Motir AI is writing a new version of this plan. You can approve or decline it when it finishes.                                                                            | Motir AI 正在编写此计划的新版本。完成后即可批准或拒绝。                                                     |
| `approvalGate.planApproval.row.reviewRow`            | Review plan — {sentence}                                                                                                                                                   | 审阅计划 — {sentence}                                                                                       |
| `approvalGate.planApproval.row.declinedNoReason`     | Declined without a reason · on <mono>{version}</mono>                                                                                                                      | 未说明原因即拒绝 · 版本 <mono>{version}</mono>                                                              |
| `approvalGate.state.declined`                        | Declined                                                                                                                                                                   | 已拒绝                                                                                                      |
| `approvalGate.withdrawn.cause.plan_stale`            | Work this plan changes was finished, so the plan went out of date and this question was withdrawn.                                                                         | 此计划要改动的工作已经完成，计划因此过期，该问题已撤回。                                                    |
| `approvalGate.withdrawn.cause.plan_discarded`        | Every proposal in the plan was withdrawn, so the plan ended and this question with it.                                                                                     | 计划中的所有建议都已撤回，计划随之结束，该问题也一并撤回。                                                  |
| `workbench.approvals.kind.plan_approval`             | Plan approval                                                                                                                                                              | 计划审批                                                                                                    |
| `approvalGate.planApproval.surface.approve`          | Approve                                                                                                                                                                    | 批准                                                                                                        |
| `approvalGate.planApproval.surface.decline`          | Decline                                                                                                                                                                    | 拒绝                                                                                                        |
| `approvalGate.planApproval.surface.consequence`      | Approving adds these to your backlog. Declining ends the plan and changes nothing.                                                                                         | 批准后，这些内容会加入你的待办列表。拒绝会结束此计划，不做任何改动。                                        |
| `approvalGate.planApproval.surface.reopened`         | Reopened from To approve · started by {name} · last active {when}                                                                                                          | 从“待审批”重新打开 · 发起人 {name} · 最近活动 {when}                                                        |
| `approvalGate.planApproval.surface.reopenedYours`    | Reopened from To approve · started by you · last active {when}                                                                                                             | 从“待审批”重新打开 · 由你发起 · 最近活动 {when}                                                             |
| `approvalGate.planApproval.surface.held`             | Motir AI is writing a new version of this plan. Approve and Decline come back when it finishes — it stays in To approve meanwhile.                                         | Motir AI 正在编写此计划的新版本。完成后即可批准或拒绝——在此期间它会一直留在“待审批”中。                     |
| `approvalGate.planApproval.surface.heldBy`           | {harness} is writing a new version of this plan. Approve and Decline come back when it finishes — it stays in To approve meanwhile.                                        | {harness} 正在编写此计划的新版本。完成后即可批准或拒绝——在此期间它会一直留在“待审批”中。                    |
| `approvalGate.planApproval.surface.stale.title`      | This plan changed while you were reading it.                                                                                                                               | 你阅读期间，此计划已被修改。                                                                                |
| `approvalGate.planApproval.surface.stale.next`       | Nothing was approved or declined. The canvas now shows the new version — look it over, then decide again.                                                                  | 没有批准或拒绝任何内容。画布现在显示的是新版本——请查看后重新决定。                                          |
| `approvalGate.planApproval.surface.seeOnly`          | Waiting on {name} to approve or decline this plan.                                                                                                                         | 等待 {name} 批准或拒绝此计划。                                                                              |
| `approvalGate.planApproval.surface.seeOnlyWhy`       | Deciding a plan needs permission to decide plans.                                                                                                                          | 决定计划需要“决定计划”的权限。                                                                              |
| `approvalGate.planApproval.surface.declined`         | You declined this plan. Nothing in your backlog changed, and it has left To approve.                                                                                       | 你拒绝了此计划。待办列表没有任何改动，它也已离开“待审批”。                                                  |
| `approvalGate.planApproval.declineConfirm.title`     | Declining this plan will:                                                                                                                                                  | 拒绝此计划将会：                                                                                            |
| `approvalGate.planApproval.declineConfirm.end`       | End it — it cannot be approved afterwards.                                                                                                                                 | 结束它——之后无法再批准。                                                                                    |
| `approvalGate.planApproval.declineConfirm.untouched` | Leave your backlog exactly as it is.                                                                                                                                       | 你的待办列表保持原样。                                                                                      |
| `approvalGate.planApproval.declineConfirm.leaves`    | Take it out of To approve.                                                                                                                                                 | 将它移出“待审批”。                                                                                          |
| `approvalGate.planApproval.declineConfirm.label`     | Why are you declining it?                                                                                                                                                  | 为什么拒绝它？                                                                                              |
| `approvalGate.planApproval.declineConfirm.helper`    | Optional. It is kept with the decision.                                                                                                                                    | 选填。会与这项决定一起保存。                                                                                |
| `approvalGate.planApproval.declineConfirm.proceed`   | Yes, decline                                                                                                                                                               | 确认拒绝                                                                                                    |
| `approvalGate.planApproval.noConversation.agent`     | {harness} wrote this plan outside a conversation, so it opened on its own page.                                                                                            | {harness} 在对话之外编写了此计划，因此它在自己的页面上打开。                                                |
| `approvalGate.planApproval.noConversation.cadence`   | Motir planned this on its own when your ready work ran out, so there is no conversation behind it.                                                                         | 这是 Motir 在你的就绪工作用完时自动规划的，因此背后没有对话。                                               |
| `approvalGate.planApproval.noConversation.earlier`   | This plan was written before Motir kept planning conversations.                                                                                                            | 此计划是在 Motir 开始保存规划对话之前编写的。                                                               |
| `approvalGate.planApproval.noConversation.next`      | Approve or decline it here — or ask Motir to change it below.                                                                                                              | 可以在这里批准或拒绝它——也可以在下方请 Motir 修改它。                                                       |
| `approvalGate.planApproval.handoff.writing`          | I have what I need — I'm writing the plan now. You don't have to wait here: close this whenever you like, and the plan will be waiting for you in <link>To approve</link>. | 信息已经足够——我现在开始编写计划。你不必在这里等待：随时可以关闭，计划完成后会在<link>待审批</link>中等你。 |
| `approvalGate.planApproval.handoff.rewriting`        | I'm writing a new version of this plan. You can close this — it stays in <link>To approve</link>, and you can decide once I'm done.                                        | 我正在编写此计划的新版本。你可以关闭这里——它会一直留在<link>待审批</link>中，等我完成后你就可以决定。       |

**Reused verbatim, with no new key:**

- _Review_ / _查看_ (`workbench.approvals.review`)
- _Awaiting_, _Approved_, _Withdrawn_ (`approvalGate.state.*`)
- _Cancel_ (`approvalGate.confirm.cancel`)
- _Nothing saved yet_, the bar counts, _Added {n} work items … Anything else?_
  (`planningWorkspace.conversation.*`)
- _Someone decided this a moment ago_ (`approvalGate.refusal.alreadyDecided.*`)
- the plan page's `planReview.approveCta` / `declineCta`

The zh words for the verbs are **批准 / 拒绝**. The workspace's _确认_ and _放弃_ stay for an ungated
proposal only.

## 22.8 Token and shape roles

| element                                  | colour                                                                                                                                                                | shape                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| row glyph                                | `--el-accent-on-surface` (a graphic, ≥ 3:1)                                                                                                                           | `h-4 w-4`                                             |
| row frame words · key · details · waited | `--el-text-secondary` (never muted: the hover fill is `--el-surface`)                                                                                                 | `text-sm` / `font-mono text-xs` / `text-xs`           |
| _Being rewritten_ pill                   | `--el-tint-sky` + `--el-text-strong` (`Pill severity="info"`)                                                                                                         | `--radius-badge` · `--spacing-chip-x/y`               |
| _Declined_ pill                          | `--el-tint-peach` + `--el-text-strong` (`severity="warning"`)                                                                                                         | as above                                              |
| _Withdrawn_ pill                         | `--el-archived-pill-bg` / `-text` (`tone="archived"`, colourless)                                                                                                     | as above                                              |
| confirm bar                              | `--el-surface`, `--el-border` top, ink `--el-text` / `--el-text-secondary`                                                                                            | `px-4 py-2.5`                                         |
| Approve / Decline                        | `Button` primary (`--el-accent` / `--el-accent-text`) / ghost (`--el-text`)                                                                                           | `--radius-btn` · `--height-btn-sm` (plan page: `-md`) |
| review block                             | `--el-accent` border, `--el-text-strong` heading, `--el-text-secondary` line                                                                                          | `--radius-card`                                       |
| decline confirm band                     | `--el-surface-soft`, `--el-border-soft` top; title `--el-text`, list `--el-text-secondary`; textarea `--el-page-bg` / `--el-border-strong`; helper `--el-text-helper` | `--radius-input` · `--spacing-input-x/y`              |
| stale band                               | `--el-tint-yellow` + `--el-text-strong`                                                                                                                               | `border-t` (bar) · `--radius-control` (rail)          |
| reopened line · no-conversation notice   | `--el-page-bg`, `--el-border`, `--el-text-strong` (MOTIR-6019's shape)                                                                                                | `--radius-control` · `--spacing-control-x/y`          |
| declined marker                          | `--el-text-secondary`, centred `text-xs` (shipped system marker)                                                                                                      | none                                                  |
| see-only line                            | `--el-text-secondary`, lock glyph `aria-hidden`                                                                                                                       | none                                                  |

There is no raw hex, no `--color-*` and no generic radius scale in either mock's authored markup or
board chrome. The compiled token layer is the one place `--color-*` is wired, exactly as in
`globals.css`.

## 22.9 a11y

- The row door's accessible name is _Review plan — {sentence}_.
- The door keeps `aria-haspopup="dialog"`, because the planning overlay is a dialog.
- _Being rewritten_ is a word, not only a tint. Its `title` explains it, and the row stays focusable.
- The disabled verbs keep `disabled` and are described by the held line beside them.
- The stale band is `role="alert"`.
- The decline textarea is labelled and `aria-describedby` its helper. It never goes `aria-invalid`,
  because it is optional.
- The hand-off bubble is inside the rail's `role="log"`. Its link is a real anchor.

## 22.10 GIVES / TAKES

- **MOTIR-6037** (the row and the surface) is GIVEN all of 22.1–22.9:
  - the row's four leading-line forms, glyph, details, _Being rewritten_ and _Declined_;
  - the access path and `planVia`;
  - the verbs' placement and labels, the consequence line and the decline confirm;
  - the held, stale, decided, see-only and no-conversation states;
  - the hand-off message and the no-guard close;
  - the copy in both catalogues.

  It TAKES one element the card did not name: the `planVia` address row and its entry in
  `design/ai-chat/design-notes.md`'s address table (flag 2).

- **MOTIR-6034** (the reads and the DTO) is GIVEN the field list in 22.3: target keys and titles,
  plan title, project name, proposal count, author triple, session id and has-turns. Nothing is
  TAKEN.
- **MOTIR-6035** (the handler): the `held` DTO field and the stale refusal are read exactly as it
  specifies. Nothing is TAKEN.
- **MOTIR-6032** (schema): the `declined` state and the two supersede causes each get a pill or a
  sentence here. Nothing is TAKEN.
- **MOTIR-6038** (every door): the verbs drawn are the existing controls, so its re-pointing needs
  no new control.
- **MOTIR-6019 / MOTIR-6024:** the reopened line gains an entrance variant. The Plans-page wording is
  unchanged.
- **MOTIR-6043** (where a Plans row opens) consumes the no-conversation fallback in 22.5. Not here.

## 22.11 ⚠️ Planning flags: what the card left open, and what contradicts shipped code

1. **The shipped close guard contradicts the hand-off.** `PlanCloseGuard` says _"Nothing is saved
   until you confirm. Closing now discards them."_ and offers Discard. Under this story a `planned`
   plan with an awaiting gate is kept and waits in To approve, and the hand-off tells the person they
   may leave. The design: **no guard opens for a gated plan, or while a plan is being written**
   (22.6). No card in MOTIR-6012 names the guard. MOTIR-6037 should own it, or it needs its own
   card. Also unverified: that the generation run continues after the overlay closes. The hand-off's
   promise depends on it.
2. **The shipped reopened line would lie.** It prints _Reopened from the Plans page_ for ANY
   `planSession` address. The design adds `planVia=approvals` (22.2), and
   `design/ai-chat/design-notes.md`'s address table owes the row. That area's notes are not part of
   this publish.
3. **Several targets.** The card decides the one-target and no-target forms only. This design leads
   with the first target and puts `+{n}` in the key cell (22.3).
4. **Relabelling the workspace verbs.** For a gated plan, _Discard_ / _Approve changes_ become
   _Decline_ / _Approve_. This is a copy change on a shipped control that follows from §11.4's verb
   and the one vocabulary. MOTIR-6037 builds it.
5. **"The rail's existing approve CTA"** is read as `PlanReviewRail`'s _Approve — add {n} items_ (the
   plan page) together with the workspace's mirrored review block. On both surfaces the gate's verbs
   ARE the existing controls, and nothing is placed beside them.

## A Plans row names the refused work item its conversation was seeded from (MOTIR-6206 · Story MOTIR-6068 — `plans-sessions--seeded.mock.html`, DATED 2026-09-25)

**This section has no Part number, on purpose.** It amends MOTIR-6019's published
`ai-planning/plans-sessions--list.mock.html`. That design is published but has not landed in
this file, and its result calls itself _Part XIX_, a number this file has since given to MOTIR-6053.
Under the rule at the top of this file, this section cites it as _MOTIR-6019's published design
result_, never by a number. The index row above points here.

Paths to published results that are not in this checkout are given relative to `design/` (for example `ai-chat/planning-workspace--resume.mock.html`). They are the results' `sourcePath`s and have not landed here.

**Asset:** `design/ai-planning/plans-sessions--seeded.mock.html`, a **DELTA** in four panels (en and
zh, light and dark, and a 375px page). It holds only the session rows that change. **The base is not
edited.** The stylesheet is lifted verbatim from the base, and every row mirrors
`app/(authed)/plans/_components/SessionRow.tsx` class for class.

**What it draws.** A conversation started by a refusal's seeded first turn
(`PlanChangeSession.seedGateId`, MOTIR-6207) says where it came from. The row's meta line gains
**Re-plan of {KEY} · {verb}** as its last item, a link to `/items/{KEY}`. This is the Plans half of
MOTIR-6068's _"the session records which gate seeded it, so the Plans row and the record band can
point at each other"_. The record band's half is **Re-plan with AI**
(`design/work-items/approval-control--replan-door.mock.html`).

### The decisions

- **The verb is the refusal's own button word.** The three verbs are _Request changes_
  (`decision_approval`), _Overturn_ (`decision_confirmation`) and _None of these_ (`decision_choice`).
  In zh they are _要求修改_, _推翻_ and _都不合适_, matching `approvalGate.verb.requestChanges`,
  `approvalGate.decisionConfirm.verb.overturn` and the choice's _都不合适_. The lookup is total over
  the three kinds that `PlanSessionRowDto.seed.gateKind` carries.
- **Two doors on one row, and they do not collide.** The row is still one stretched link (the title's
  `after:absolute after:inset-0`), and it still reopens the conversation. The seed link is raised above
  it with `relative z-10`, as the state chip already is. Pressing **Re-plan of ACME-44** opens the work
  item. Pressing anywhere else on the row reopens the conversation.
- **The link's face.** It is secondary ink with a `--el-border-strong` underline (`underline-offset-2`)
  that turns `--el-text` on hover. The key is in `font-mono`, like the anchor. It has its own focus
  ring and one tab stop. Its accessible name is _"Open {KEY}, the work item this conversation
  re-plans"_ / _"打开 {KEY}，即此对话重新规划的工作项"_. It is **never truncated**. On a narrow page the
  meta line wraps (`flex-wrap`, unchanged), and the link moves to its own line as one unit.
- **Unresolvable means nothing extra.** The seed can be `null` because the gate row was deleted
  (`SetNull`) or because the viewer can no longer browse the refused work item. In either case the row
  looks exactly like an unseeded row. It is not dimmed, the link is not struck through, and there is no
  "unavailable" label. Saying that a link is hidden would confirm that it exists.
- **The anchor stays.** The anchor slot is the conversation's scope, which can grow to `{first} +N`.
  The seed link is its provenance. For a seeded row both name the same key when the row is created,
  but they are different facts, and the anchor slot keeps working as it always has.

### Copy (MOTIR-6209 owns the keys; suggested under `aiPlanning.sessions.seed`)

| key           | en                                                     | zh                                     |
| ------------- | ------------------------------------------------------ | -------------------------------------- |
| `seed.label`  | `Re-plan of {key}`                                     | `{key} 的重新规划`                     |
| `seed.verb.*` | `Request changes` · `Overturn` · `None of these`       | `要求修改` · `推翻` · `都不合适`       |
| `seed.aria`   | `Open {key}, the work item this conversation re-plans` | `打开 {key}，即此对话重新规划的工作项` |

### GIVES / TAKES

- **MOTIR-6209** gets the row: its placement, face, two-door stacking, copy and the null case. This
  matches its criteria. Nothing is taken away.
- **MOTIR-6208 / MOTIR-6209 — ⚠️ one flag.** A seeded row's TITLE is its first turn, and the seed's
  first line is `{key} · {title}`. If a member who cannot browse the refused work item can still see
  the session row on the Plans list, the row's title shows that work item's key and title, even
  though the seed link is correctly `null`. This is not new. Every row already shows its first turn
  under the list's access scope (MOTIR-6025). But the seed makes it certain that a work item's title
  is in that text. MOTIR-6209's scope check covers the link, not the title.
- **MOTIR-6210 and MOTIR-6211** are not affected by this surface.

Referenced for provenance only: MOTIR-6011, MOTIR-6019, MOTIR-6025, MOTIR-6053, MOTIR-6070,
MOTIR-6071. `ACME-42`, `ACME-44`, `ACME-47` and `ACME-60` are sample keys.

# Part XXIII — the plan DRAWN AS IT IS WRITTEN: the generating pane, its motion, and the hand-over (MOTIR-6294 · Story MOTIR-6158 — `plan-review--live-drawing.mock.html`)

> **Superseded in part by Part XXVIII (MOTIR-8591, 2026-10-15).** On the planning overlay while a
> plan is `generating`, this Part's _the canvas never moves after the reader navigates_ (§23.8) is
> replaced by _follow while on; the person's navigation turns following off; Follow the planner asks
> again_. Outside `generating` this Part stands as written. Read Part XXVIII §28.2 before §23.7–23.8.

**The asset:** one DELTA mock, `design/ai-planning/plan-review--live-drawing.mock.html`, eleven sheets.
No `.png` (AMENDMENT 4).

**Read the mock as an INTERACTION SPEC, not a layout.** The surface this Part draws is defined by
movement — a card landing, an arrow drawing in, a withdrawn card leaving — and a still frame
under-specifies all of it. So every motion is a row of numbered frames (before → during → after), and
this Part gives each one its property, its duration, its easing and its reduced-motion form (23.4,
23.5). A "during" frame is a real render with the moving element held at its mid-transition value.

## 23.0 What this Part composes, and the five things it adds

**It composes, and does not redraw:** `PlanProposalViews` and its pane header (Part XXI, Part VIII
§2), `PlanReviewCanvas` with `mergePlanLevel`'s edges and the off-level anchor (Parts IX, XIII,
MOTIR-5387), `PlanProposalList` (Part VIII §3, Part XIII §7), Part VI's op treatments,
`ProjectRoadmapCanvas`'s breadcrumb and MOTIR-6161's follow offer, `PlanChangeConfirmBar` (Part
XXII) and `PlanChangeRail` with its hand-off bubble (Part XXII §20.6).

**It adds five elements, and nothing else:**

| element                     | where                                                         | 23.x  |
| --------------------------- | ------------------------------------------------------------- | ----- |
| the **live marker**         | the pane header's RIGHT end — the slot Part IX released       | 23.1  |
| the **arrivals count**      | the canvas breadcrumb row — the follow offer's own shape      | 23.7  |
| the **present-tense empty** | `PlanProposalList`'s empty statement, while generating        | 23.9  |
| the **discarded band**      | `PlanProposalViews`' `band` slot                              | 23.12 |
| the **zero-turn MCP note**  | the rail, under the reopened line, in the rail's notice idiom | 23.11 |

**And one behaviour: MOTION** — opt-in on `PlanningCanvas`, specified in 23.3–23.5.

## 23.1 Decision 1 — while generating, the pane IS the proposed pane, minus the bar

**The pane is `PlanProposalViews` from the plan's first live read**, fed by the generating poll
(MOTIR-6295), exactly as Part XXI mounts it once the plan is proposed. It is not `PlanChangeCanvas`
taught to draw live, and it is not a third component. **Why:** the story's hardest criterion is that
the hand-over does not jump, and the only construction that satisfies it by definition rather than by
care is one component on both sides of the hand-over (23.12).

**The footer slot is EMPTY while generating** — no bar, no strip, no "writing…" line. Part XXI 21.8
settled that an empty foot hides and the canvas runs to the pane's edge, and why: _the rail on the
right IS the planner_. A generating plan has nothing to decide, so it has no bar. (The card offered a
writing-in-progress strip as the alternative; it would be the second voice 21.8 rejected.)

**What DOES say "this is being written" is a quiet marker at the pane header's right end** (sheet 1).
Part VIII reserved that end for Show changes and Part IX released it, so it is free, and it is the
right place: without the marker the generating pane is indistinguishable from a proposed pane whose bar
has gone missing, and a reader looking for Approve should be told why it is not there on the pane
itself, not only on the rail. It is a 6px dot plus a word, `text-xs`, `--el-text-secondary`:

- **Being written** — dot `--el-status-in-progress`, the in-progress hue the canvas already uses for a
  running edge. **Static.** It does not pulse: the pane stays open for the length of a run, and a
  permanent loop there is the attention sink `app/globals.css` warns about for the running edge.
- **Reconnecting — showing the last update** — dot `--el-warning` (23.8).

`role="status"`, `aria-live="polite"`, so the change between the two is announced once. It leaves at
the hand-over.

## 23.2 Decision 2 — the switch shows from the FIRST read, zero proposals included

The List | Canvas switch renders as soon as the plan exists, before any proposal has arrived (sheet 1
panel A). Part XXI 21.6 already draws an EMPTY proposed plan with its switch, _"because there IS a
plan"_; a generating plan with nothing in it yet is the same case one status earlier. Hiding the switch
until the first batch would add a 44px header arriving mid-read, pushing the canvas down under the
reader. With it there from the start, the only thing that arrives later is the bar, which overlays
(21.8), so nothing is ever pushed.

**The canvas stands where the reader stood** (MOTIR-6154 / MOTIR-6161): inside the target, showing its
committed children. Before the first proposal it is the committed level, undecorated, and **Show
changes** is disabled because there is nothing to show.

## 23.3 Decision 3 — the level RE-LAYS on every change, and the cards GLIDE

**The finding that made this a decision.** Measured on the shipped layout (renders at `origin/main`):
the level's auto-layout re-computes every cell whenever its node or edge set changes, because
dependency RANK decides the columns. One arriving card moved three others — the two committed children
from the first row to the fourth, and the first proposal from column three to column one (sheet 2).
One withdrawal reshuffled six cards (sheet 5). A live pane will re-lay on most batches.

**Two answers were weighed:**

- **FREEZE** every drawn card where it is and place arrivals in free cells. Rejected: the arrangement
  IS the information — columns are the order the planner is proposing — so a frozen level draws the
  plan in the wrong order, with arrows pointing backwards, which is the one thing a person is watching
  for. And it cannot hand over: a fresh open of the proposed plan lays it out properly, so the frozen
  live pane and the proposed pane would disagree, and the hand-over would have to jump.
- **GLIDE** — every card moves to its new cell with a transition. **Chosen.** The level is always the
  plan page's own layout of the plan as it stands, the hand-over is exact (23.13), and the reflow is
  continuous, so a reader can follow a card with their eye.

**A change is STAGED, never simultaneous** (sheets 2 and 5): first the cards that must make room glide,
then the new cards enter the cells that are now free, then the arrows draw in. An exit runs the other
way: the card leaves, then the rest glide into the gap, then the arrows draw in. Staging is what keeps
an entering card from appearing underneath a card still sliding through its cell.

**Arrows are hidden for a glide.** Edge routes are computed from node rectangles; a card moving by CSS
transition has a route that is already at its end. So every edge touching a card that is about to move
fades out first, and fades back in on its final route when the glide is done. **A gliding card passes
BENEATH cards that are not moving** (it keeps its DOM order; nothing raises it).

**The viewport never moves.** No arrival re-fits the canvas and no arrival pans to itself. The canvas's
once-only arrival fit (MOTIR-3837) is the pane's mount, not a batch. A card that lands outside the
visible part of the level is not counted (it is on this level) — the shipped LOCATE control reaches
it.

## 23.4 The motion spec

**The implementation idiom is the shipped one and nothing else**: CSS transitions and one keyframe,
declared in `app/globals.css` and gated behind `@media (prefers-reduced-motion: no-preference)`, exactly
as `.canvas-edge-running` is (MOTIR-3972). `package.json` carries no animation library and this adds
none. **The static form is the default**; motion is added, never removed.

**Durations are the design system's own tokens**, so a style that is snappier or slower
(`[data-style]` sets `--transition-fast / -duration / -slow` from 40–260ms and up) moves the canvas at its
own pace. **Easings are two constants** declared beside `.canvas-edge-running` (no style overrides an
easing today, so they are not theme tokens):

- `--canvas-ease-enter: cubic-bezier(0.2, 0, 0, 1)` — decelerate, for anything arriving or settling;
- `--canvas-ease-exit: cubic-bezier(0.3, 0, 1, 1)` — accelerate, for anything leaving.

| change                                           | what moves                           | property / values                                                                                                           | duration                  | easing       | order                                                                   |
| ------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------ | ----------------------------------------------------------------------- |
| **ARRIVAL** (an `add`, or a card moved IN)       | the new card                         | `opacity 0 → 1`, `transform translateY(6px) scale(0.98) → none`                                                             | `--transition-slow`       | enter        | after any glide; several in one batch stagger **40ms**, capped at 160ms |
|                                                  | its arrows                           | `opacity 0 → 1`                                                                                                             | `--transition-duration`   | enter        | after the cards have entered                                            |
| **RE-LAY** (a card's cell changes)               | the card                             | `left`, `top`                                                                                                               | `--transition-slow`       | enter        | first; its arrows `opacity → 0` over `--transition-fast` just before it |
| **REWIRE** (edge set changes, no cell changes)   | the removed arrow · the new arrow    | `opacity 1 → 0` · `opacity 0 → 1`, at the same time                                                                         | `--transition-duration`   | exit · enter | simultaneous; an arrow that only RE-ROUTES does not fade                |
| **EXIT** (a withdrawn `add`)                     | the card and every arrow touching it | `opacity 1 → 0`, `transform scale(0.96)`                                                                                    | `--transition-duration`   | exit         | first; then any re-lay; then the arrows                                 |
| **MOVE OUT** (`parentRef` to another level)      | as EXIT                              | as EXIT, plus the arrivals count increments (23.7)                                                                          | as EXIT                   | exit         | as EXIT                                                                 |
| **DEEPEN** (body, type, title, sizing filled in) | the card's outline                   | `outline: 2px solid var(--el-accent-on-surface)`, `outline-offset: 2px`, held **600ms**, then `outline-color → transparent` | fade: `--transition-slow` | exit         | in place; no card moves and no arrow changes                            |

- **What each change IS is decided by diffing two consecutive snapshots by node id** — never by
  reading an event. An id that appears is an ARRIVAL; an id that disappears is an EXIT unless it
  appears on another level, which makes it a MOVE (its `parentNodeId` changed); a changed edge set is a
  REWIRE; a changed title / type / body / sizing on a kept id is a DEEPEN. The snapshot is the unit
  because it is the only one the poll has (MOTIR-6295: each read REPLACES the set).
- **An exiting card is RETAINED for its transition** and removed on `transitionend`, with a fallback
  timer of the duration plus 50ms so a card never lingers when the event does not fire.
- **A read that changes nothing plays nothing.** Nor does the first read of a pane: a pane that opens
  on a plan already twenty cards in draws them settled, because nothing ARRIVED while the reader
  watched.
- **A read that lands while a change is still playing** completes the change in flight and then
  plays the difference between what is drawn and the new snapshot. It never replays an arrival.
- **Suggested class names for the MOTION card** (a name is the card's to settle): `canvas-node--enter`,
  `canvas-node--exit`, `canvas-node--relay`, `canvas-node--deepened`, `canvas-edge--enter`,
  `canvas-edge--exit`.

**A proposed `remove` of a committed card is NOT an exit** (sheet 5 ⑤). The card stays on the level in
Part VI's removal treatment, because nothing has been removed: the plan PROPOSES it. It arrives like any
other card.

**The ONE CARD survives every one of these unchanged.** The unified card ([MOTIR-6296](motir:cmugpy3gj00o3hwoi940o565s))
keeps every Part VI op treatment — the dashed accent `add`, the info-ring `modify`, the struck
`remove`, the decided spine and badge — and the motion is applied to the canvas's NODE BOX, never to the
card inside it, so no treatment is touched. **`locked` appears in exactly one place**: a `modify` or
`remove` whose TARGET is terminal (done / cancelled). A terminal card the plan does not touch is drawn
as `/roadmap` draws it — sheet 1's done card MOTIR-6159 is a plain `WorkItemNode`, no hatch.

## 23.5 Reduced motion — every change, with nothing moving

Under `prefers-reduced-motion: reduce` **no transition runs and no keyframe plays**: the level is
redrawn in its new state in one frame. Each change must still READ as a change (sheet 8):

| change              | its reduced form                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| arrival             | drawn in place with the DEEPEN outline, held **1200ms**, then removed with no fade — the outline is a STATE, not a motion |
| re-lay              | cards are at their new cells; arrows at their final routes                                                                |
| rewire              | the new arrow is there, the removed one is not                                                                            |
| exit · move out     | the card and its arrows are gone; a move out still increments the arrivals count                                          |
| deepen              | the outline, held 1200ms, removed with no fade                                                                            |
| live marker · count | unchanged — neither moves                                                                                                 |

The outline is held longer than the animated form's 600ms because nothing else draws the eye to it.

## 23.6 Arrows arrive WITH their cards — the edge rules, restated for a live level

Nothing here is a new edge rule; `mergePlanLevel` is the one engine and it already says all of it. What
this Part fixes is WHEN each is drawn:

- **An arrow is drawn once BOTH its ends are on the level**, in the batch's edge phase (23.4). A lay
  batch's `blockedByRefs` can only name proposals already appended, so a card's in-level blockers are
  normally already drawn when it lands.
- **An arrow whose other end has NOT arrived** — possible when that end is moved INTO this level later
  — is simply absent, and draws in when that end lands. There is no placeholder.
- **A blocker on ANOTHER level** takes the plan page's off-level treatment: the ghost anchor naming it,
  the `cross` arrow, the "blocked elsewhere" flag (sheet 1 panel C). The anchor ARRIVES with the card
  that needs it and EXITS with the last card that needed it (sheet 4).

## 23.7 The ARRIVALS count — counted, never jumped to

**What counts:** an ARRIVAL (an `add`, or a card moved in) on any level other than the one being
viewed, since the reader last stood on that level. Visiting a level clears its count. Only the plan's
own cards count; a committed card never "arrives".

**Where:** the canvas breadcrumb row, as a pill at its right end, in **the shipped follow offer's own
markup** — the same `bg-(--el-card)` control, the same 6px `--el-accent` dot, the same sentence shape
(_"Plan is in {identifier} · Go there"_):

- ONE level → **"{count} new in {identifier} · Go there"**, which goes to that level;
- SEVERAL → **"{count} new elsewhere · latest in {identifier} · Go there"**, which goes to the level of
  the LATEST arrival.

Going there is a navigation the reader chose, so it is the one thing allowed to move the canvas; it
drills by the arriving card's `parentTrail`, which every review item already carries.

**ONE slot.** When MOTIR-6161's follow offer is up (the reader stepped away from a target that
settled), the offer wins the slot and the count is not drawn: the offer already names where the plan
lands (sheet 7 C). When the reader is at the ROOT, where the shipped row renders no breadcrumb, the row
renders with the root crumb and the pill only — no Back, because there is nowhere to go back to.

## 23.8 Follow-once vs never-jump

- **The pane opens where the reader stood** (`canvasHeldTrail`), whichever pane they were on before.
- **The first proposal of a plan whose target settled mid-conversation** may carry the canvas inside
  that target ONCE, exactly by MOTIR-6161's rule and through its seam (`followTo`). Nothing in this
  Part changes that rule.
- **After the reader has navigated, nothing moves them** — not a batch, not a move, not the hand-over.
  They are told instead: by the follow offer, or by the arrivals count.

## 23.9 The LIST is live too

The same pane's other body (sheet 9). Rows appear in the order the plan receives them — the snapshot's
item order — in their section, with the card's entrance (`opacity 0 → 1`, `translateY(4px) → none`,
`--transition-slow`, enter easing). A withdrawn row leaves with the exit. Reduced motion: rows simply
are or are not there.

**⚠️ The shipped empty statement is FALSE while a plan is being written.** `PlanProposalList` says
_"No proposals — This plan finished without proposing anything. Declining ends it — nothing in your
backlog changes."_ A generating plan has not finished and cannot be declined from here. So while the
plan is `generating` the list's empty statement is present-tense: **"Nothing proposed yet"** /
**"Items appear here as the plan is written."** (sheet 9 A; corrected at build, §23.14). The shipped statement stays for a plan
that really did finish empty.

## 23.10 The dropped read

A read that fails is retried on the next tick and **the last good snapshot stays drawn** — nothing is
cleared, dimmed, greyed or alerted. After **three consecutive failures** (≈7.5s at the 2.5s poll) the
live marker turns to **"Reconnecting — showing the last update"** with a `--el-warning` dot (sheet 1
panel D), and the next good read turns it back. A recovered read is a normal snapshot: because each one
REPLACES the set, a card is never drawn twice and a withdrawn card never returns, and the canvas ends in
the state a fresh open would draw.

## 23.11 — the zero-turn MCP rail

An agent's conversation happened in its own
harness, so the session of an MCP-authored plan can hold **no turns** (MOTIR-6157,
`docs/decisions/mcp-authored-plan-review.md`). The rail then says where the conversation was — one
notice, **under the reopened line and above the opener**, in the rail's own notice idiom (the reopened
line's border, fill and ink), led by the lucide `bot` glyph the plan page already uses for an
MCP-authored plan's attribution (`PlanReviewRail`'s `writtenByHarness`):

> **"The conversation behind this plan happened in {harness}, so it isn't shown here. Ask below to
> change the plan."**

`{harness}` is the plan's recorded `authorHarness` (sheet 10 B: _Claude Code_). It shows when the plan
in hand has `authorSource: 'mcp'` and a harness, and the session has no turns. **It stays once a turn
is sent** — it is still true — and it never shows for a hosted plan, whose conversation IS the rail
(sheet 10 A, where the shipped hand-off bubble already says the plan is being written).

**The composer stays live.** The starter chips and the composer render exactly as for any session;
asking here changes the plan like any other turn.

## 23.12 The DISCARDED pane

`generating → declined` with `decisionReason: 'discarded'` is reachable directly: a plan closed holding
zero proposals is discarded by the close, decided by nobody (`plansService.markPlanned`). The pane
(sheet 11 ③ ④):

- **no bar** — there is nothing to decide;
- **the live marker leaves**;
- **a band** in `PlanProposalViews`' `band` slot — between the header and the body, where the plan page
  puts its establish band — saying it in **the plan page's own words**,
  `planReview.discardedOutcome`: _"Plan discarded before it finished — your work items are unchanged"_.
  One state, one sentence, on both surfaces;
- **the canvas keeps its level**, undecorated; the List shows the shipped title **"No proposals"**
  without the shipped body, whose _"Declining ends it"_ is false for a plan already declined.

## 23.13 The HAND-OVER

**`generating → planned` is a single frame pair in which only the bar changes** (sheet 11 ① ②): the
confirm bar arrives over the canvas's bottom edge (Part XXI 21.8 — it overlays, so nothing resizes and
the clusters do not move), and the live marker leaves. **The component is not remounted**: the view,
the level, the zoom and pan, the Show changes state, every card and every arrow are the ones already
drawn. The bar's own arrival is Part XXII's and is not animated here.

| status                   | the pane                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `generating`, 0 items    | this Part, sheet 1 A                                                                         |
| `generating`, items      | this Part, sheets 1–9                                                                        |
| `planned`                | Part XXI (sheets 1–2), with the bar of Part XXII §20.4 — the hand-over INTO it is sheet 11   |
| `stale`                  | Part XXI sheet 4 B and Part XXII §20.5 — not redrawn                                         |
| `approved`               | Part XXI sheet 6 and Part VI's decided treatment (MOTIR-3162 keeps the review) — not redrawn |
| `declined` (`reviewed`)  | as `approved`, in the declined tense — not redrawn                                           |
| `declined` (`discarded`) | this Part, 23.12 and sheet 11 ③ ④                                                            |

## 23.14 Copy

Both catalogues are owed — `messages/en.json` AND `messages/zh.json` (the zh-parity gate).

**New keys:**

| key                                       | en                                                                                                             | zh                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `planReview.liveWriting`                  | Being written                                                                                                  | 正在编写                                                                    |
| `planReview.liveReconnecting`             | Reconnecting — showing the last update                                                                         | 正在重新连接 — 显示的是最近一次更新                                         |
| `planReview.liveAnnounce`                 | {count, plural, one {# item} other {# items}} added to the plan                                                | 计划新增了 {count} 个工作项                                                 |
| `planReview.listWritingTitle`             | Nothing proposed yet                                                                                           | 尚无提案                                                                    |
| `planReview.listWritingBody`              | Items appear here as the plan is written.                                                                      | 计划编写过程中，工作项会出现在这里。                                        |
| `planningWorkspace.arrival.arrivedIn`     | {count} new in {identifier} · Go there                                                                         | {identifier} 中有 {count} 项新内容 · 前往                                   |
| `planningWorkspace.arrival.arrivedAcross` | {count} new elsewhere · latest in {identifier} · Go there                                                      | 其他层级有 {count} 项新内容 · 最新在 {identifier} · 前往                    |
| `planningWorkspace.session.mcpNoTurns`    | The conversation behind this plan happened in {harness}, so it isn’t shown here. Ask below to change the plan. | 此计划背后的对话发生在 {harness} 中，因此不会显示在这里。可在下方提出修改。 |

**⚠️ CORRECTED AT BUILD (MOTIR-6300, 2026-09-25) — two strings above.** As approved, `liveAnnounce`
and `listWritingBody` said _card(s)_ / 卡片. That is this corpus's shorthand for a work item, not the
product's noun, and the shipped reader-facing-noun guard (`tests/i18n-catalog.test.ts`) refuses it. They
ship as _item(s)_ / 工作项, and the two rows above record the shipped strings. The approved published
result (evidence `cmugtqshe007shytxfxtjiaxl`) still carries the old wording; this mirror records what
ships.

**Reused, verbatim:** `planReview.discardedOutcome` (23.12), `planReview.listEmptyTitle` (23.12),
`planningWorkspace.arrival.goToTarget` (23.7). Every other string in the asset is the shipped
catalogue's, rendered from it.

`{identifier}` is the level's crumb key — the work item's `MOTIR-<n>`, or the folder's name for a
folder level. `arrivedIn` / `arrivedAcross` take no plural form in either language because the number
stands alone before "new" / "项".

## 23.15 a11y

- **Arrivals are announced, once per batch**, through a polite live region: `planReview.liveAnnounce`
  with the batch's count — never per card, and never for a read that added nothing. A deepen, a rewire
  and a re-lay are not announced; an exit is not announced (it is the reader's own agent's withdrawal,
  and announcing every correction is noise).
- **Nothing moves focus.** A focused card that glides keeps focus. A focused card that EXITS hands
  focus to the canvas itself (`role="application"`), never to the page.
- **The live marker is `role="status"`**, so _Being written → Reconnecting_ is heard.
- **The arrivals pill is a real `<button>`** whose text is its name, as the follow offer's is.
- **Reduced motion** is 23.5, and the outline it holds is not colour alone: it is a 2px outline at
  3:1-on-surface ink (`--el-accent-on-surface`, MOTIR-4474), on a card that already has a label.

## 23.16 Token and shape roles

Nothing new. Every element in the asset is a shipped component's own markup, and the five new ones are
built from shipped idioms: the live marker's dot is the follow offer's dot at `--el-status-in-progress`
/ `--el-warning`; the pill IS the follow offer; the band is `--el-surface-soft` + `--el-border` +
`--el-text-strong`; the note is the reopened line; the present-tense list statement is
`PlanProposalList`'s own. The deepen outline is `--el-accent-on-surface`, never `--el-accent` — a mark
ON the board owes 3:1 against `--el-canvas`, which the fill misses in four light palettes (MOTIR-4474).

The asset's board chrome paints only through `--el-*`, with `--radius-card` for the board; `.seg-ic`
is declared presentation-free for the reason Part XXI 21.9 gives.

## 23.17 How the asset was produced

- **Every pane, card, arrow, anchor, breadcrumb, list row, confirm bar and rail is the real components'
  DOM**, rendered through `tests/helpers/renderWithIntl.tsx` in happy-dom on `origin/main`
  @ `34b43b9ff`, with the per-level roadmap read stubbed exactly as `plan-review-canvas*.test.tsx` stub
  it. So the layout, the cells, the edge routes, the dashed pending arrows, the off-level anchor and its
  flag are the shipped engine's output, not a drawing.
- **The Close + project bar** is copied from Part XXI's asset, which copied it verbatim from
  `PlanningWorkspaceHost.tsx`.
- **The dependency legend is drawn COLLAPSED** — a real state, reached through its own toggle in the
  render — so it does not cover the committed cards.
- **A "during" frame** is the real render with inline `opacity` / `transform` / `left` / `top` set to
  the transition's midpoint; nothing is redrawn to make one.
- **The five new elements** are rendered as JSX with their real lucide glyphs, so their markup is not
  typed by hand.
- **The first stylesheet** is Tailwind v4.3.0's output compiled over this document's class attributes
  with `@motir/design-system/theme.css` and `@motir/brand/brand.css` (the rail's Motir glyph). Five
  rules nothing carries were dropped: three utilities minted from prose words (`inline`, `table`,
  `transform`) and the `.style-vignette > .sv-canvas` rules for a component this asset does not draw.
- **Every lucide glyph is a `<symbol>` in one sprite sheet** at the top of the body, each carrying the
  provenance comment the sprite audit reads, and each use site keeps the component's own outer `<svg>`
  and classes. `node scripts/audit-mock-sprites.mjs … --strict`: **28 symbols, 0 undeclared, 0
  drifted** against `lucide-react@1.16.0`.
- **The frames of a motion sequence show the CANVAS only.** The Close bar, the pane header, the
  breadcrumb and the controls are identical across a sequence, sheet 1 establishes them, and sheets 7
  and 11 — which are ABOUT that chrome — keep it. Cropping keeps every card at the same place across a
  sequence's frames, so the eye can compare them.
- **It is ≈1.9MB formatted**, larger than any other mock, because it carries ~30 real renders of a
  populated level and Prettier indents their nesting. It is committed anyway: this project keeps a
  committed `design/` mirror that the design lane reads, and landing the notes is what stops the next
  design taking the number XXIII (21.0).
- **It was rendered and looked at** in headless Chromium, sheet by sheet, and **all 243 specs of the
  design lane** (`vitest.design.config.ts`) are green over it.

## 23.18 GIVES / TAKES

Over every `MOTIR-<n>` the new mock and this Part name:

- **MOTIR-6158** (the story) — neither. It is the container.
- **MOTIR-6295** (ONE generating poll) — **GIVES** nothing and **TAKES** nothing it does not already
  have: the snapshot-replace rule (23.4, 23.10) and the three-failure `failing` flag (23.10) are its own
  criteria, which this Part draws.
- **MOTIR-6296** (ONE CARD) — **GIVES** the ratification that every Part VI op treatment survives the
  unification, and the one place `locked` appears (23.4). Takes nothing.
- **MOTIR-6297** (MOTION) — **GIVES** 23.3–23.5 as its spec: the staging, the glide, the edge hide,
  the property / duration-token / easing table, the retention rule and the reduced-motion forms.
- **MOTIR-6298** (NO TURNS) — **GIVES** 23.11: the notice, its placement, when it shows, its copy.
- **MOTIR-6299** (ONE LEVEL BUILDER) — neither. It is a refactor this Part does not see, and the edges
  drawn here are already `mergePlanLevel`'s.
- **MOTIR-6300** (LIVE PANE) — **GIVES** 23.1, 23.2, 23.7, 23.8, 23.9, 23.10, 23.12 and 23.13: the pane
  swap, the empty foot, the live marker, the switch from the first read, the arrivals count and its
  precedence, the present-tense list, the discarded band and the hand-over.
- **MOTIR-6301 / MOTIR-6302** (the integration gate and the E2E) — **GIVE** them the observable
  criteria: one component across the hand-over, one announcement per batch, no card or arrow twice.
- **MOTIR-6161** — **TAKES** the follow-once rule and the follow offer, unchanged; **extends** the offer's
  slot to carry the arrivals count when the offer is down (23.7).
- **MOTIR-6157** — **TAKES** the decision that an MCP-authored plan is reviewed on the surface, turns or
  no turns; this Part is the "legible with no turns" its Consequences hands to MOTIR-6158.
- **MOTIR-6184** (Part XXI) — **TAKES** the pane, the empty foot and the overlaying bar, unchanged;
  fills the `generating` row its 21.5 table left to this story.
- **MOTIR-6033** (Part XXII) — **TAKES** the confirm bar at the hand-over, unchanged.
- **MOTIR-3234** (Part VIII) — **TAKES** the pane header, and **names** a limit: §4's _Discard this plan_
  for a generating plan lives on the plan page and is not brought here (23.19).
- **MOTIR-3972** — **TAKES** the motion idiom: static by default, motion added under `no-preference`.
- **MOTIR-3837** — **TAKES** the once-only arrival fit; no batch re-fits (23.3).
- **MOTIR-5387** — **TAKES** the off-level anchor, whose arrival and exit 23.6 times.
- **MOTIR-4474** — **TAKES** the rule that a mark on the board is `--el-accent-on-surface`.
- **MOTIR-3162** — **TAKES** that a review survives its decision (23.13's table).
- **MOTIR-6154 / MOTIR-6159** — **TAKES** where the canvas stands (23.2). Neither changes.
- **MOTIR-6223 / MOTIR-6241** — neither: the level band is not redrawn here.

## 23.19 What Part XXIII does NOT draw or decide

- **Anything inside a card, the list row, the confirm bar, the decline band or the rail's turns** — all
  shipped and composed.
- **What an op MEANS**, the outcome axis, or any Part VI treatment.
- **The transport** — MOTIR-6295's (a poll, by decision of shipped code).
- **Discarding a generating plan from the surface.** Part VIII §4 gives the plan page _Discard this
  plan_; the surface's rail already has Stop for a Motir AI run. An MCP-authored plan being written has
  no discard control on the surface, and adding one is a decision for another card, not a gap this
  Part fills.
- **The level band** of MOTIR-6223 / MOTIR-6241.
- **The plan page's own live poll**, which is unchanged.
- **Motion anywhere but the planning canvas's nodes and edges** and the list's rows. The motion is
  OPT-IN on `PlanningCanvas`; `/roadmap`, runs and onboarding do not get it.

---

# Part XXV — APPROVE, WHILE IT RUNS: the four states, the count in the copy, the motion, on the planning overlay (MOTIR-5248 · Story MOTIR-5246 — `plan-review--approve-progress.mock.html`, DATED 2026-10-08 — second revision: the overlay only)

**Design system — files read:** `package.json` (root; motir-core is not a monorepo app and its root
manifest is the web app's: `"@motir/design-system": "workspace:*"`), `app/globals.css` (line 13:
`@import '@motir/design-system/theme.css';`), `node_modules/@motir/design-system/package.json`
(`"version": "0.10.0"`, exports `./mock`), `app/layout.tsx` (the `data-style` / `data-palette` /
`data-type` attributes on `<html>`), and `packages/design-system/src/theme/{styles,palettes,typography}.ts`
(the registries those attributes resolve against). There is no `DESIGN.md`.

**Verdict: ON MOTIR DESIGN — branch (a).** Both checks hold. The installed version is **0.10.0**, and it
exports `@motir/design-system/mock`, so the asset is built with **`renderMock`**. The project's axes:
`app/layout.tsx` writes each signed-in user's own preference onto `<html>`, and with no preference it
writes nothing, so the `:root` defaults apply: **`data-style="warm-editorial"` ·
`data-palette="motir"` · `data-type="motir"`** (`DEFAULT_STYLE_ID`, `DEFAULT_PALETTE_ID`, and
`warm-editorial`'s own `defaultTypeId`). These are the project's defaults and the package's defaults
at the same time, because motir-core is the package's home. The mock renders at exactly those axes.

**Package parts, product parts, new parts:**

| part                                                  | where it comes from                                                                               | disposition                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Spinner` (`sm`)                                      | `@motir/design-system` — the package's own part, rendered by `renderMock`                         | composed as is, plus one class (`motion-reduce:animate-none`)                                                                                                |
| `Button` (primary · ghost, `md` / `sm`)               | `@motir/design-system`, inside the shipped confirm bar render                                     | unchanged, cited                                                                                                                                             |
| `PlanChangeConfirmBar`                                | product-local, `components/planning/` — rendered on `origin/main` in happy-dom and spliced in     | unchanged host; this Part draws INTO the bar                                                                                                                 |
| the overlay rail's review block and error bubble      | product-local, `PlanChangeRail.tsx` — class strings copied, text resolved from `messages/en.json` | unchanged hosts                                                                                                                                              |
| **`PlanApproveProgress`** (running + timed-out bands) | NEW                                                                                               | **product-local component** — it speaks one product moment, a plan's materialize, in `planReview.*` copy; nothing about it is general enough for the package |

Nothing is proposed as an addition to `@motir/design-system`.

**A Part number, checked before it was taken (the rule under the table at the top of this file).**
`list_designs` over `design/ai-planning/` shows **MOTIR-6628's published, not-landed result already
calls itself Part XXIV** (evidence `cmuk89dnv009qhwtxlqmekkw3`, obsolescence). So this Part is **XXV**,
and XXIV is missing from this file on purpose until MOTIR-6628 lands. (MOTIR-6044's published
addition also calls itself "Part XXI" — a collision it made before the rule existed; it is not this
Part's to repair.)

**THE CARD IS NOT ALREADY BUILT.** The dispatch warned that moooon-B-V/motir-core#3146 touched this
file after the card was filed. That pull request added the MOTIR-6206 section (a Plans row naming its
refused work item). It shares the file and nothing else: no approve progress, no timeout copy, no
threshold.

**How the earlier refusal was answered.** The 2026-09-30 publish of this Part (gate
`cmuodk0o6002rhxoiql82ys7h`) was sent back with the note _"don't need it for now"_. That note is about
timing, not about the drawing: it names no element, copy or placement to change. Yue has since asked
for MOTIR-5246 to run, so the design is wanted now. This revision answers the note by **refreshing,
not redrawing**: it re-renders the same states against `origin/main` @ `066fb94e9` and design system
0.10.0, and corrects the two premises that moved since (the overlay's approved outcome, 25.2, and the
timeout's rollback, 25.2). Every element, string and threshold is the one drawn on 2026-09-30.

**How the second refusal was answered — the overlay only.** The 2026-10-08 publish (gate
`cmuzlgisc000zhvoimqqbvfwr`) was sent back with _"I think screens 0 - 2 are outdated, approve will
always be on the overlay now"_. That is a product decision (Yue, 2026-10-08): **a plan is approved on
the planning overlay, and the plan page's review rail is no longer an approve door.** So this revision
**removes every page-rail drawing**: the old access-path panel and the two page-rail panels (old 0–2),
and the page frames inside the narrow, reduced-motion and zh panels. Reduced motion and zh are
redrawn on the overlay's confirm bar and review block, which they did not show before. The overlay
drawings themselves (old 3–4) are unchanged and renumbered 0–1. The code on `origin/main` still mounts
an Approve in the page rail (`PlanDetail` → `PlanReviewRail`); retiring it is not a design card's
work, and 25.13 flag 6 names what it leaves for the plan.

**The Part number still holds.** The unnumbered section MOTIR-7634 published sits after Part XXIII
and calls itself nothing, and MOTIR-6628's result still claims XXIV, so XXV collides with nothing.

## 25.0 Drawn against SHIPPED reality

Rendered on `origin/main` @ `066fb94e9` (2026-10-08) with `tests/helpers/renderWithIntl.tsx` in happy-dom, before
anything was drawn:

| host                            | what ships in the approve moment                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plan page, `PlanReviewRail`     | `busy` → the primary `Button` gets `loading` (a `Spinner` replaces its check, `aria-busy`), and is `disabled`. **Its label still reads _Approve — add 33 items to your backlog_**, a count of work that has not happened. Decline is disabled. The hint _Approve materializes the proposals into your backlog._ stays.                                                     |
| plan page, the timeout          | `PlanDetail` keeps the code (`err.code` → `PLAN_APPROVE_TIMED_OUT`), but the rail's error arm has no case for it, so it prints the generic `planReview.actionError` — _Something went wrong. Please try again._ — in `--el-danger-on-surface`. **The one refusal that can promise "nothing was written, pressing again is safe" says the same thing as every other.**      |
| overlay, `PlanChangeConfirmBar` | `deciding` → a bare `Spinner` beside the two verbs, both disabled. The counts and consequence line stay.                                                                                                                                                                                                                                                                   |
| overlay, the review block       | `PlanChangeRail`'s block mirrors the bar: its verbs go disabled. No words change.                                                                                                                                                                                                                                                                                          |
| overlay, the timeout            | `planDecisionErrorCode` FLATTENS it: `PLAN_APPROVE_TIMED_OUT` is not one of its cases, so it becomes `APPROVE_ERROR` → the rail prints `planningWorkspace.conversation.error.body` (_That didn't go through. Your conversation is saved — try again, or rephrase the change._) in a rose bubble, beside a _Try again_ that re-runs the conversation turn, not the approve. |

The server side is exactly as the card describes: `APPROVE_TX_BUDGET = { timeoutMs: 30_000,
maxWaitMs: 10_000 }` (`lib/services/plansService.ts`), `translateApproveTimeout` turns P2028 into
`PlanApproveTimedOutError` (`lib/plans/errors.ts`), and the route answers **503** with `{ code:
'PLAN_APPROVE_TIMED_OUT', planId, itemCount }`.

**The overlay host is not what the card names.** The card places the overlay's approve in
`PlanChangeRail` / `PlanEditsReviewDock`, and the overlay story names `usePlanEditsJob`.
`PlanEditsReviewDock` was retired by MOTIR-4261 and `usePlanEditsJob` no longer exists. The overlay's
approve today is **one hook** (`usePlanChangeConversation.approve`, phase `deciding`) with **two
doors**: the canvas **confirm bar** and the rail's **review block** that mirrors it. The host already
records which one was pressed (`PlanningWorkspaceHost`'s `approveFrom('bar' | 'rail')`). This Part
draws those two doors. A third one — `PlanCloseGuard`'s _Confirm and close_ — is a planning flag
(25.13).

## 25.1 The access path

**No new door.** The surface opens only from the Approve a reader already has on the planning overlay:
the confirm bar's _Approve_ (or _Approve changes_ on an ungated plan) at the canvas foot, or the same
verb in the rail's review block. No panel draws them at rest: both are shipped and unchanged, and
pressing either leads to Panels 0–1.

## 25.2 The four states

| state                | when                                                    | the planning overlay (Panels 0–1)                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **creating**         | the press lands, until 8 s                              | Pressed from the bar: **the bar's contents become the progress** — spinner, the bold line (_Applying 18 changes to your backlog…_), and _They all arrive together when it finishes._, in the bar's own two-line grammar at its own `min-height: 3.5rem`. The review block mirrors it in its rail form, silently.                                                                                            |
| **still going**      | **8 s after the press** (25.3), until an answer         | Only the lower line changes, in the bar and in the mirror: _Still working — a large plan takes longer. There's no need to press again._ The upper line and the spinner stay.                                                                                                                                                                                                                                |
| **timed out**        | the answer is 503 `PLAN_APPROVE_TIMED_OUT`              | **A `role="alert"` band stacks above the bar**, exactly where the shipped stale band stacks: timer glyph, **_Nothing was created — approving took too long._** _This plan still awaits your decision, unchanged. It's safe to approve again._ The bar is back at rest with live verbs. If the press came from the rail, the band sits in the review block instead (`place="rail"`), as the stale band does. |
| **failed otherwise** | any other refusal the host has no specific sentence for | **UNCHANGED**: the shipped rose bubble in the conversation, and a live bar.                                                                                                                                                                                                                                                                                                                                 |

The refusals that already have their own sentences — `PLAN_REVISION_IN_FLIGHT`,
`APPROVAL_GATE_STALE_SUBJECT`, `PLAN_FOLDER_MISSING`, the gate's `held` / `decided` / `stale` — keep
them. "Failed otherwise" means only the generic arm.

**Success is not a fifth state.** When approve answers 200, the progress leaves and the shipped
approved outcome arrives exactly as today: the **session end** (AMENDMENT 23 §2): the approve transaction ends the planning session `approved`
(`endDecidedSession`, `lib/services/plansService.ts`), and the rail shows `SessionEndMarker` (the
_Approved_ `Pill`) and `EndedComposerSlot` in place of the composer. Nothing about that moment is
redrawn. (The 2026-09-30 draft said "the after-approve turn"; that turn no longer exists.)

**A timeout ends nothing.** `PLAN_APPROVE_TIMED_OUT` is the approve transaction running out of budget,
so the whole transaction rolls back, the session end with it. The session stays open, the plan still
awaits a decision, and the composer stays live. That is what lets the band say _This plan still
awaits your decision, unchanged._ truthfully, and it is why the band sits above live verbs rather
than beside an end marker. The rail's generic failure arm is now `state.errorCode && !ended`; it
behaves exactly as before for a session that did not end, which a timeout's is.

### The timeout and the generic failure, side by side (Panel 1)

**One sentence for the reader: a YELLOW BAND with a timer glyph, opening with _Nothing was created_
and ending with _safe to approve again_, means press again; a ROSE BUBBLE in the conversation with neither promise means read before you press.** They differ in four independent ways —
container (band vs. bubble), hue (`--el-tint-yellow` vs. `--el-tint-rose`), glyph (timer vs. none)
and words — so no single one of them, including colour, carries the difference alone.

**Why yellow, the stale band's tint, and not a new one.** The stale refusal and the timeout ask for
the SAME response: nothing was written, look, and decide again. The rail and the bar already have a
band for "nothing was written, decide again" (`PlanStaleBand`, Part XXII §22.5), so the timeout takes
its grammar — the same container, the same tint and ink, the same placement — and is told apart from
stale by its glyph (`timer-off`, not `refresh-cw`) and its sentence. A new tint would have invented a
second vocabulary for the same instruction.

### The three facts, and how many are on screen

All three of `PlanApproveTimedOutError`'s facts are on screen, in the order a worried reader needs
them:

1. **nothing was created** — the title, bold, first;
2. **the plan still awaits you** — _This plan still awaits your decision, unchanged._;
3. **pressing again is safe** — _It's safe to approve again._

None is dropped. The sentence says _approve again_ rather than naming the button, because the button's
label differs by plan (_Approve_ on a gated plan, _Approve changes_ on an ungated one) and a sentence
that quoted one of them would be wrong for the other.

**What it does NOT say:** "the plan is too large", which the error's own message offers. The
`approveRefusals` classification (`lib/plans/approveRefusals.ts`) records the budget as a property of
the database's load at the moment of the press, not of the plan. Telling a person their plan is too
big, when a retry will very likely succeed, would send them to cut a plan that is fine.

## 25.3 The slow threshold: **8 seconds**

**`APPROVE_SLOW_AFTER_MS = 8_000`.** The still-going line appears 8 s after the press. The code card
reads this number from here and cites this line.

Why 8:

- **It sits above the measured case.** `APPROVE_TX_BUDGET`'s own note records the failing fixture —
  15 adds + 27 edges — at **~5.03 s** before the edge pass was batched. A plan of that size, which is
  an ordinary one, finishes inside 8 s and never sees the reassurance. A reassurance that fires on
  every approve stops meaning anything.
- **It lands before 10 s**, the limit at which a person's attention leaves a task that shows no sign
  of progress. The reassurance has to arrive before the reader decides the product has hung, not
  after.
- **It is far from the ceiling.** The timeout arrives at most **~40 s** after the press (10 s
  `maxWait` + 30 s `timeout`). Eight seconds leaves the reassurance on screen for the long tail
  without pretending to be a warning.

The threshold is measured **on the client, from the press**, by the component. It uses no server
time, no poll and no second read.

## 25.4 The component: `PlanApproveProgress` (product-local)

One component, `PlanApproveProgress.tsx`, NEW in `components/planning/` beside `PlanChangeConfirmBar.tsx`, mounted by the overlay's two doors.
It is presentational: **no `fetch`, no router, no search params.**

| prop       | type                      | meaning                                                                                                                                                          |
| ---------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`    | `'running' \| 'timedOut'` | `running` covers creating AND still going: **the component owns the 8 s timer**, from mount, so no host can pick a different threshold.                          |
| `count`    | `number`                  | `review.itemCount` (the overlay's review is a `PlanReviewDto`).                                                                                                  |
| `kind`     | `'adds' \| 'changes'`     | `adds` when every proposal is an `add`; `changes` when any is a `modify` or `remove`. It picks _Adding {n} items…_ or _Applying {n} changes…_ (25.8).            |
| `place`    | `'rail' \| 'bar'`         | The rail form (a row plus a centred line under it) or the bar form (the bar's own two-line row) — the `PlanStaleBand` precedent.                                 |
| `announce` | `boolean`, default `true` | Whether this instance is the live region. **Exactly one mounted instance announces**: the one at the door that was pressed. The overlay's mirror passes `false`. |

**The component has no `failed` state.** The overlay's generic failure is the shipped conversation
bubble, unchanged, so nothing about it is the component's. (The 2026-09-30 draft carried `failed` only
to render the page rail's generic line, and the page rail is no longer a door.)

**The press cannot be doubled.** While `running`, the host renders the component INSTEAD of the bar's
contents, so no Approve exists to press. The mirror's verbs
are replaced too. The host keeps its `busy` / `deciding` guard as well.

## 25.5 The motion: `Spinner`, and nothing else

**The motion primitive is the shipped `Spinner` from `@motir/design-system`**
(`packages/design-system/src/components/ui/Spinner.tsx`, size `sm`, `animate-spin`, a
`border-current` ring with a transparent top). The surface uses no `animate-pulse` skeleton, because
a skeleton stands for content that is about to appear in its place, and nothing appears in the
footer. It adds no keyframe and no CSS of its own.

- **Colour:** `text-(--el-accent-on-surface)` — the ring is `border-current`, so the token colours it.
  A graphic needs 3:1, and this is the rule MOTIR-4474 set for a mark on a board.
- **`aria-hidden`:** the spinner's own `role="status"` / _Loading_ label would compete with the
  sentence. The component's wrapper is the live region, and the words are what it announces.

**No animation dependency is introduced.** `package.json` and `packages/design-system/package.json`
gain nothing, and a later reader meeting a plain CSS spinner here should read that as the decision
MOTIR-5246 recorded (no Lottie, no animation runtime), not as an unfinished job.

## 25.6 Reduced motion: the words stay, the motion stops (Panel 3)

Under `prefers-reduced-motion: reduce`:

- the `Spinner` carries **`motion-reduce:animate-none`** and stands still as a static ring. It stays
  `aria-hidden`, so it is decoration either way;
- **every word is identical** to the animated form;
- **the 8 s swap still happens.** It is a change of text, not a motion, and it is the part a
  reduced-motion reader needs most, because the ring no longer tells them anything is running;
- nothing fades, slides or pulses anywhere in the surface, so there is nothing else to stop.

The shipped `Spinner` keeps spinning under reduced motion today (`app/globals.css` gates only the
nav-pending frame, the launcher shimmer and the orb). This Part adds the class on this use only. It
does not change `Spinner` for everyone (25.13, flag 4).

## 25.7 The overlay, at its own widths (Panels 0–2)

| place                | width                                                               | placement                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| overlay confirm bar  | the canvas pane (the viewport minus the 22rem rail)                 | **In the bar, at the bar's own `min-height`.** The bar is absolutely positioned over the canvas foot, and it does not change height when it starts running — **the canvas does not reflow**, which is the overlay story's one hard constraint. |
| overlay review block | the 22rem rail                                                      | Inside the block, under its _Nothing saved yet_ heading, in the rail form. The heading stays, because it is still true until the transaction commits.                                                                                          |
| **narrow, < md**     | 375px, one column: canvas over rail (`PLANNING_FRAME_STACKED_ROWS`) | The bar is full width, and **its lower line WRAPS instead of truncating** (the counts line truncates today). _There's no need to press again_ is the sentence that matters, and truncation would cut it off.                                   |

The overlay frames in the mock are drawn at 880px (a 528px canvas pane beside the 22rem rail), the
widest the board allows. The bar stretches with the pane, and nothing in it depends on the width.

## 25.8 Copy — `messages/en.json` and `zh.json`

All new strings sit under **`planReview.approveProgress`**, next to the rail's `approveCta` /
`approvedOutcome`. The overlay reads the same keys, because it mounts the same component, so it adds
none.

| key                                        | en                                                                           | zh                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `planReview.approveProgress.creating`      | Adding {n, plural, one {# item} other {# items}} to your backlog…            | 正在将 {n} 个工作项加入待办列表…                       |
| `planReview.approveProgress.applying`      | Applying {n, plural, one {# change} other {# changes}} to your backlog…      | 正在应用 {n} 项变更…                                   |
| `planReview.approveProgress.together`      | They all arrive together when it finishes.                                   | 完成后它们会一起出现。                                 |
| `planReview.approveProgress.slow`          | Still working — a large plan takes longer. There’s no need to press again.   | 仍在处理 —— 计划越大，耗时越长。无需再次点击。         |
| `planReview.approveProgress.timedOutTitle` | Nothing was created — approving took too long.                               | 未创建任何内容 —— 批准耗时过长。                       |
| `planReview.approveProgress.timedOutNext`  | This plan still awaits your decision, unchanged. It’s safe to approve again. | 这份计划仍在等待你的决定，内容未变。可以放心再次批准。 |

**Why _Adding N items to your backlog…_ and not the card's _Creating N work items…_.** The overlay's
consequence line already says _Approving adds these to your backlog_ before the press, and the
approved turn's own verbs are _added_ / _changed_ / _removed_. The progress is the tense between
them, so they read as one sentence moving through time. A new noun ("work items")
and a new verb ("creating") in the middle would break that. **_They all arrive together_** is the
honest substitute for a progress bar. It tells the reader the operation is one step, which is true
(`materialize` is one transaction), and that explains why there is no bar to show.

**Why a second string for mixed plans.** `review.itemCount` counts every proposal, and a `modify` or a
`remove` is not "added to your backlog". A plan of 15 adds, 2 changes and 1 removal reads _Applying 18
changes to your backlog…_ (Panel 0) and never claims to add 18 things. (The shipped CTA does claim
that; see 25.13, flag 3.)

## 25.9 Token and shape roles (everything added, `--el-*` only)

| element                           | colour                                                                 | shape                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| running row (rail form)           | `--el-surface-soft` fill, `--el-border` border, `--el-text` ink        | `--radius-card` · `--spacing-control-x/y` · `min-h-(--height-btn-md)` (holds a button's height) |
| running line under it (rail form) | `--el-text-secondary` (AA on `--el-surface`)                           | `text-xs`, centred — the hint slot's own classes                                                |
| running bar (bar form)            | `--el-surface`, `--el-border` top; `--el-text` / `--el-text-secondary` | the bar's own `px-4 py-2.5`, `min-height: 3.5rem` (`PLAN_CONFIRM_BAR_HEIGHT`)                   |
| spinner                           | `--el-accent-on-surface` (via `border-current`)                        | `Spinner size="sm"`, `rounded-full` (a circle, allowed)                                         |
| timed-out band, rail form         | `--el-tint-yellow` + `--el-text-strong`                                | `--radius-control` · `--spacing-control-x/y` (the `PlanStaleBand` rail form)                    |
| timed-out band, bar form          | `--el-tint-yellow` + `--el-text-strong`, `--el-border` top             | `px-4 py-2.5` (the `PlanStaleBand` bar form)                                                    |
| timer glyph                       | inherits `--el-text-strong`, `aria-hidden`                             | `size-3.5`                                                                                      |

No `--color-*`, no raw hex, and no `rounded-md` / `p-2` / `h-9` in anything added. The compiled
token layer in the mock's stylesheet is the only place `--color-*` appears, exactly as in
`globals.css`. **No new token is needed**: every role above already exists.

## 25.10 a11y

- The running wrapper is `role="status"` (polite). It announces the creating line on mount and the
  still-going line when it swaps. **Only one instance announces** (`announce`, 25.4), so an overlay
  press is not read twice.
- The timed-out band is `role="alert"`, like the stale band. Focus is not moved: the reader's focus
  was on Approve, and Approve is back, enabled, in the same place.
- The spinner and the timer glyph are `aria-hidden`. The words carry every meaning.
- While running, no disabled Approve remains to be focused. The verbs are gone, not greyed.

## 25.11 How the asset was produced

- `renderMock` from **`@motir/design-system/mock` 0.10.0**, at `warm-editorial` / `motir` / `motir`.
  It compiles Tailwind v4.3.0 over the document's own classes with the package's `theme.css`.
- The host is the **real component's DOM**: `PlanChangeConfirmBar`, rendered on `origin/main` @
  `066fb94e9` through `renderWithIntl` (en and zh catalogues) and spliced in verbatim. The running
  states replace the bar's CONTENTS. The timed-out state stacks the band above the real bar.
- The overlay rail's review block and error bubble are **copied class strings from
  `PlanChangeRail.tsx`**, with their text resolved from `messages/en.json` through a lookup that
  throws on a missing key (21.11's rule).
- The new component is JSX built on the package's `Spinner` and lucide's `TimerOff`.
- The theme's `.style-vignette > .sv-canvas` rules were dropped: this asset draws no style vignette,
  and direction (B) of `design-mock-utility-correspondence` rules on a rule nothing carries.
- There is **no dark panel**. `renderMock`'s nested `data-theme="dark"` did not flip the tokens, and
  a dark panel that renders light is what `design-dark-parity` exists to fail. Every role in 25.9
  is one the shipped rail and stale band already carry in dark.
- It was rendered and looked at, panel by panel, in headless Chromium, and **all 278 specs of the
  design lane** (`vitest.design.config.ts`) are green over it.

## 25.12 GIVES / TAKES — every key this Part names

Grepped over the subtree: MOTIR-5246's children (5248, 5249, 5251, 5252), MOTIR-5247's children
(5250, 5253, 5254), and the `/ready` story MOTIR-5266 / 5267, which relates to both.

- **MOTIR-5249** (the component, its copy, and — as filed — the page wiring)
  - GIVES — **element:** `PlanApproveProgress`, its props, the running and timed-out visuals (25.2,
    25.4, 25.9); the six strings (25.8). **structure:** it renders INSTEAD of the bar's contents while
    running, and as a band above the bar on a timeout; the 8 s timer lives in the component.
  - TAKES — **premise:** the card wires the component into the PLAN PAGE rail. This revision
    withdraws that placement (Yue, 2026-10-08: approve is on the overlay only), so its page wiring
    has nothing to build; see 25.13 flag 6. Its acceptance criterion also quotes _"Creating N work
    items…"_; this Part settles _Adding {n} items to your backlog…_ / _Applying {n} changes…_ (25.8).
- **MOTIR-5251** (the vitest gate) — GIVES the rules to assert per state: the threshold at 8 000 ms;
  exactly one announcing instance; `motion-reduce:animate-none` on the spinner. TAKES nothing.
- **MOTIR-5252** (acceptance E2E) — GIVES the en and zh strings to read on screen, on the overlay, and the fact that
  the timeout's recovery is the ordinary Approve, not a separate retry control. TAKES nothing.
- **MOTIR-5246** (the story) — GIVES its four states, the count, and the no-dependency /
  no-determinate-progress stance, all kept. TAKES one refinement on the **element** axis: the count's
  sentence splits into adds-only and mixed forms (25.8). TAKES one change on the **premise** axis:
  its title names the PLAN PAGE as the place approve speaks, and approve is now on the overlay only.
- **MOTIR-5247 / MOTIR-5250** (the overlay story and its code card)
  - GIVES — **element:** the bar form and the silent mirror (Panels 0–4). It is now the ONLY placement. **structure:** the
    component replaces the bar's contents at the bar's own height; the band stacks above the bar, as
    the stale band does; `announce` follows `approveFrom`'s `bar | rail`.
  - TAKES — **premise:** both cards name `PlanEditsReviewDock` and `usePlanEditsJob` /
    `PlanEditsPhase 'approving'`. Neither exists (MOTIR-4261 retired the dock). The overlay's one
    approve hook is `usePlanChangeConversation`, whose phase `deciding` covers **both** approve and
    discard, so MOTIR-5250 must tell which decision is running (the host's `approveFrom` already
    knows). **structure:** `planDecisionErrorCode` flattens `PLAN_APPROVE_TIMED_OUT` into
    `APPROVE_ERROR`, so MOTIR-5250 must add a `timedOut` case, or the overlay can never show 25.2's
    band.
- **MOTIR-5253 / MOTIR-5254** — GIVE nothing new. They TAKE the same premise correction as MOTIR-5250:
  there is ONE overlay hook with two doors (bar, review block), not two hooks.
- **MOTIR-5266 / MOTIR-5267** (the `/ready` nudge, the fourth door) — GIVES the component and its
  copy for that placement to compose. TAKES nothing. Its Card-width placement is MOTIR-5267's to draw.
- **MOTIR-4261** — TAKES its retirement of `PlanEditsReviewDock` as the premise 25.0 corrects.
- **MOTIR-6037** — TAKES the stale band's grammar and placement (`PlanStaleBand`, `place` bar/rail),
  reused unchanged for the timeout (25.2).
- **MOTIR-4474** — TAKES the rule that a mark on a surface is `--el-accent-on-surface` (the spinner).
- **MOTIR-3396** — TAKES the error class and its 503; this Part only gives it words.
- **MOTIR-7629 / MOTIR-7632 / MOTIR-7646** (the confirmed session-end decisions) — TAKES their
  premise that an approve ends the overlay's session, as the success outcome 25.2 cites, and that a
  rolled-back approve ends nothing, which the timeout band relies on. GIVES nothing.
- **MOTIR-7634** — named only for the Part-number check (its section is unnumbered).
- **MOTIR-6628 / MOTIR-6044 / MOTIR-6206** — named only for the Part-number check and #3146. No
  element, structure or premise is given or taken.

## 25.13 ⚠️ Planning flags

1. **The overlay cards name a host that no longer exists.** MOTIR-5247 / 5250 / 5253 / 5254 cite
   `PlanEditsReviewDock`, `usePlanEditsJob` and `PlanEditsPhase 'approving'`. All are gone
   (MOTIR-4261). The overlay's approve is `usePlanChangeConversation`'s `deciding`, shared with
   discard. The placement drawn here is correct for the code as it ships. The cards' context refs
   and acceptance criteria ("the `approving` phase of `PlanEditsPhase` is what drives it") need a
   re-plan before MOTIR-5250 runs.
2. **A third overlay door no card owns: `PlanCloseGuard`'s _Confirm and close_.** It approves and then
   closes the workspace, showing only a bare `Spinner` in the dialog footer. Its timeout closes
   nothing and says nothing specific. Neither story names it. It should compose the same component
   inside the dialog, or be named out of scope explicitly.
3. **The shipped CTA miscounts mixed plans.** _Approve — add {n} items to your backlog_ and
   _Added {n} items to your backlog_ both use `review.itemCount`, which counts `modify` and `remove`
   proposals as "added". This Part does not repeat the mistake (25.8), but it does not fix the CTA or
   the outcome, which belong to the rail's shipped copy. No card owns them.
4. **`Spinner` ignores `prefers-reduced-motion` everywhere.** This Part adds `motion-reduce:animate-none`
   to its own use only. Whether the package's `Spinner` should carry it by default is a
   design-system decision no card here owns.
5. **The overlay's generic-failure _Try again_ re-runs the conversation turn, not the approve.** After
   an approve fails generically, the rail's _Try again_ (`onRetry` → the last user turn) is disabled
   or sends a turn again. Drawn UNCHANGED here, because "failed otherwise" is out of this card's
   scope. It is a defect in the shipped path, and no card owns it.
6. **The page placement is withdrawn, and the plan still builds it.** Approve now lives on the
   planning overlay only (Yue, 2026-10-08), but MOTIR-5249 is written to wire the component into
   `PlanReviewRail`, and MOTIR-5246's title is about the plan page. The overlay wiring is
   MOTIR-5250's, in the other story. So MOTIR-5249 either becomes "the component and its copy" with
   MOTIR-5250 consuming it, or the two stories merge. And the page rail's own Approve still ships
   (`PlanDetail` → `PlanReviewRail`); whether it is removed, and by which card, no card says. All
   three need a re-plan before MOTIR-5249 runs.

## 25.14 What Part XXV does NOT draw or decide

- The Approve / Decline buttons, the rail's footer, the confirm bar, the review block, the approved
  outcome, the establish step, or the workspace chrome. All are cited and drawn INTO.
- A percentage, a bar or a step list. `materialize` reports none, and inventing one would promise a
  time nothing measures.
- Anything server-side: the budget, the transaction, the 503.
- Decline and discard, and their failures.
- The `/ready` nudge's placement (MOTIR-5267) and the close guard's (flag 2).

## ⭐ The Plans page — Waiting to resume (MOTIR-7907, 2026-10-10)

Mock: `plans-tabbed-list--waiting-to-resume.mock.html` — a DELTA on `plans-tabbed-list--closed.mock.html` (MOTIR-7634).

- **A failed hosted session is OPEN**, so it no longer reads Closed, and it must not read Generating either: it is a new state, **Waiting to resume**, between Generating and Waiting for approval. **The tab** sits directly after Generating with its count; the strip now holds eight state options plus All and still scrolls below `sm`.
- **The chip.** Its tone is the To resume state pill's (`--el-tint-yellow`, `--el-text-strong`): distinct from Generating's info (sky) and Closed's warning (peach), and it carries the same word as the tab. (The design-system `Pill` has no yellow tone yet, so the code card adds `tone="awaiting"` to the part rather than inlining the tint.)
- **The stop line** takes the place of _active {when}_ as Closed's end line does: _Stopped at {where} · because {why} · {time}_, in the same step and reason words as the To resume entry.
- **The door.** The row opens the overlay at that session through MOTIR-7884 (`planVia=resume`); the chip is a plain pill, **not** a second door (one control, one tab stop).
- **A project manager sees every member's waiting row here** (panel 2b; added after review, 2026-10-10): the row is unchanged, the overlay it opens offers Resume to the starter and to a project manager, and the reader's own To resume tab stays their own list.
- **A waiting row with no plan yet** (the attempt failed before the first proposal) reads the same, with _Untitled conversation_ and the stop line naming where.
- **SUPERSEDES** MOTIR-7634's _Closed · the attempt failed_ end line for a hosted failure: it now applies only to a legacy session that a failure ended before this story.
- **Strings:** `aiPlanning.sessions.planState.waiting` Waiting to resume / 待继续, `aiPlanning.sessions.stop` _Stopped at {where} · because {why} · {time}_ / _停在{where} · 原因：{why} · {time}_.
- **GIVES:** MOTIR-7921 (tab, chip, stop line, door; 45 min still fits). **TAKES:** the failed→Closed row from MOTIR-7634.

## ⭐ The Plans page — a situation-2 session's row (MOTIR-7935, 2026-10-10)

Mock: `plans-tabbed-list--situation-2.mock.html` (a DELTA on MOTIR-7907's `plans-tabbed-list--waiting-to-resume.mock.html`).

- **The row reads the PLAN's own state, not the session's failure:** _Waiting for approval_ (or _Out of date_), never Closed and not _Waiting to resume_ — the plan is what the person can act on, and it keeps the accent border the retired row's `awaitingReview` rule gave a plan that needs a decision. The session's failure is the stop line (_Your last change could not be made · {time}_), in the place _active {when}_ takes.
- **The door:** the overlay at that session through MOTIR-7884; an undecided plan keeps its chip door (MOTIR-7889), and the row's own door is the same overlay.
- Drawn beside a failed-walk row (_Waiting to resume_) and a Closed row, in light, dark and zh.
- **GIVES:** MOTIR-7921 and MOTIR-7944 (the row; both still fit). **TAKES:** nothing from MOTIR-7907.

# Part XXVI — a plan being written: its PROGRESS, which items are being written NOW, and when it has STALLED (MOTIR-7821 · Story MOTIR-7820 — `plan-review--live-progress.mock.html`, LANDED 2026-10-12 by MOTIR-8299)

A DELTA over **Part XXIII** (`plan-review--live-drawing.mock.html`, MOTIR-6294). Part XXIII and its
mock are not edited; every rule there holds unless a section below says it amends it, and each such
section names the § it amends.

**The number — published as Part XXV, landed as Part XXVI (MOTIR-8299).** MOTIR-7821's design
result (evidence `cmuzmvvgu004vhwoipfw3u8d8`, approved) was published on 2026-10-08 calling itself
**Part XXV**: Part XXIV was taken by MOTIR-6628's published, not-landed result (_plan review shows a
proposed OBSOLESCENCE mark_), so XXV was the next number. MOTIR-5248's approve-progress design was
published fifteen seconds earlier under the SAME number, by the same rule, and it is the one that
landed here as Part XXV. This result never landed, so for four days the code cited "Part XXV §25.n"
for the progress line and the drafting cue while that address in this file resolved to the
approve-progress design, and `plan-review--live-progress.mock.html` resolved to no file at all.

So this Part is the published result's Part XXV, landed under the next free number. **Its text is
the published text, renumbered and nothing else**: every `§25.n` of the result is `§26.n` here, one
to one (the drafting cue is §26.6, the laying cue §26.7, the motion spec §26.8, the stalled threshold
§26.9), and every citation of another Part is unchanged. **The mock is the approved bytes, unedited**,
so its own panel captions still say "Part XXV §25.n" — read them as §26.n. A citation of this design
is "Part XXVI §26.n"; "Part XXV" in this file is MOTIR-5248's approve-progress design and nothing
else.

## 26.0 What this Part adds

Story MOTIR-7820 stores, on a `generating` plan, the SET of in-flight steps (one per running planner
session: `settle` · `lay` with a parent or with none · `author` with a target or with none, each with
its `startedAt`) and a `lastActivityAt` stamped by every signal and every proposal write (MOTIR-7822).
MOTIR-7825 derives from them ONE progress value for every surface. This Part designs what that value
looks like:

1. **The progress line, PANE form** — in the pane header of the planning surface and the plan page
   (sheets 1–2), with a details popover and the requester's pointer to Workbench › Planning.
2. **The progress line, COMPACT form** — one row, the thing a Workbench › Planning row composes
   (sheet 3).
3. **The DRAFTING cue** — on every card a current `author` step targets (sheets 4–5).
4. **The LAYING cue** — on the parent a current `lay` step targets, in three places (sheet 6).
5. **The off-level wording** of Part XXIII's one arrivals slot (sheet 7).
6. **The STALLED state** and its threshold, as ONE constant (26.9).

It adds no second canvas, no second level builder and no second live read: the cue is a layer on the
shipped node box of the ONE canvas, and the steps travel on the ONE generating-plan read
(`useGeneratingPlanPoll`, 2.5 s).

## 26.1 Every panel is labelled `PlanStatus · step kind`

The PlanStatus is always `generating` while anything here shows, except the hand-over panels
(`planned`, `declined`). The step kinds are `settle`, `lay (targeted)`, `lay (untargeted)`,
`author (targeted)`, `author (untargeted)`, plus the two non-kinds the derivation can return:
**no step yet** (no signal ever — _Starting…_) and **no step reported** (the planner signals nothing,
or is between sessions).

| state (MOTIR-7825)                                     | marker word (shipped slot)             | progress line                                     | canvas cues                | sheet |
| ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------- | -------------------------- | ----- |
| `starting` — no signal yet                             | **Starting…**                          | elapsed · last activity (counts once M > 0)       | none                       | 1A, 2 |
| `working` — ≥ 1 current step                           | Being written                          | step words · +N more · N of M · elapsed · last    | every targeted step        | 1B, 2 |
| `writing` — signalled before, none now / never signals | Being written                          | N of M · elapsed · last activity                  | none                       | 2, 9  |
| `stalled` — quiet > threshold                          | **Stalled** (warning dot)              | N of M · elapsed · **no activity for {duration}** | none (every step aged out) | 2, 9  |
| read failing (Part XXIII §23.10)                       | Reconnecting — showing the last update | the last snapshot, unchanged                      | the last snapshot, held    | 2, 9  |
| `planned` / `declined`                                 | — (leaves)                             | — (leaves)                                        | — (leave, same frame)      | 10    |

The marker's WORD carries the state, so a reader who reads one thing reads it right; the line is the
detail. The stalled/recovered pair is drawn in sheet 9.

## 26.2 The pane form — placement and anatomy (sheets 1–2)

**Where:** in the shipped pane header (`PlanProposalViews`, `h-11`), right of the shipped live marker
(`data-testid="plan-live-state"`, unchanged except for its word). The header is the one strip both
the planning surface and the plan page carry, and it is already where "this plan is live" is said —
so the hand-over (§26.12) removes things and moves nothing.

**Order, left to right:** `[Segmented]` … `[marker]` `[progress button]` `[pointer]` `[sr-only announce]`.

- **The progress button** (`data-testid="plan-progress"`, `<button aria-expanded aria-controls>`):
  `step words` (`min-w-[7rem] truncate`, `--el-text`, medium) · `+N more` · `N of M authored` ·
  `elapsed` · `last activity`, separated by `·` glyphs (`aria-hidden`), then a `chevron-down`
  (`chevron-up` open). Text `text-xs --el-text-secondary`; box `h-(--height-control)`,
  `px-(--spacing-control-x)`, `rounded-(--radius-control)`, hover `--el-surface-soft`, open state
  `--el-surface-soft` fill; `max-w-[44rem]`.
- **The details popover** (sheet 1C) is the shipped `Popover` surface (`data-surface="popover"`,
  `--el-page-bg`, `--el-border`, `--shadow-elevated`, `--radius-card`, `p-(--spacing-card-padding)`),
  24rem wide, aligned to the header's right end. Content: an eyebrow _Working on now_; one row per
  current step — full words (`text-sm --el-text`), then _Started {time} · running {duration}_
  (`text-xs --el-text-secondary`); the counts; _Started {time} · running {duration}_ for the plan;
  _Last activity {time}_; the stalled sentence when stalled; the pointer sentence with its link. With
  no step it says _No step reported — the planner may not report its steps._ It is the only place a
  truncated title is read whole (besides the step span's `title`).
- **The pointer** (`data-testid="plan-progress-pointer"`): _Follow from Workbench_ + `arrow-up-right`,
  `--el-link`, `text-xs` medium, an `<a href>` to Workbench › Planning, `aria-label` = the full
  sentence _You can leave — this plan keeps being written. Follow it from Workbench › Planning._ **It
  shows only to the plan's requester** (`Plan.createdById` = the reader) — the tab lists only the
  reader's own plans, so for anyone else it would lead nowhere (sheet 2).

**N of M authored** is hidden while M = 0 (before the first lay result). **Elapsed** is from
`Plan.createdAt`.

**Width — the drop order (sheet 2).** The step words truncate first (CSS ellipsis, never below 7rem).
When the line still does not fit: **last activity** drops, then **elapsed**, then the pointer moves
into the popover. Counts never drop. Drawn at 720 px and 560 px pane widths, and while the
Reconnecting word is long (it costs the same space as a narrow pane). Implement it on the header's
own width (a container query or a measured width), not the viewport's.

## 26.3 One step, two, many — and which one is in words

**Only one step is ever in words in the line: the EARLIEST by `startedAt`, ties by `sessionKey`** —
the order MOTIR-7825 returns. Earliest, not latest, because a later step starting must not change the
words the reader is reading; the words change only when that session ends. Then:

| current steps | line                                | canvas                                    |
| ------------- | ----------------------------------- | ----------------------------------------- |
| 0             | no words (§26.1 decides the marker) | nothing                                   |
| 1             | `Authoring: {title}`                | its one cue (if targeted and on the plan) |
| 2             | `Authoring: {title}` `+1 more`      | both cues                                 |
| many (6)      | `Authoring: {title}` `+5 more`      | every targeted cue at once (sheet 4)      |

`+N more` counts the steps the derivation returned, so a dropped step (withdrawn target, aged-out
session) is not counted (sheet 9). The popover lists them all in the same order.

**Long titles truncate with CSS ellipsis** on the step span alone; the counts and the times never
truncate. The compact form caps the words at 28ch.

## 26.4 Times — formats and the tick

The client ticks **once a second** off the derivation's `serverNow` (MOTIR-7825's clock correction),
so no poll is needed to advance a time; what the reader sees changes only at these granularities:

| value         | < 10 s                                                                                                          | 10 s – 59 s                                  | 1 – 59 min                | ≥ 60 min                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------- | ------------------------------------------------ |
| elapsed       | `<1 min`                                                                                                        | `<1 min`                                     | `{m} min`                 | `{h} h {m} min`                                  |
| last activity | `just now`                                                                                                      | `{s} s ago`, in **10 s steps** (10, 20 … 50) | `{m} min ago`             | `{h} h {m} min ago` (uses the elapsed formatter) |
| stalled       | —                                                                                                               | —                                            | `no activity for {m} min` | `no activity for {h} h {m} min`                  |
| popover       | clock time `HH:mm:ss` in the reader's locale and timezone for _Started_ / _Last activity_; durations as elapsed |

Ten-second steps, because a counter that changes every second is motion in the corner of the eye;
minutes are what a waiting person reads. **The tick never decides stalled** — stalled comes from the
derivation on a read, so a dropped read cannot make a plan look stalled (§26.10).

## 26.5 The compact form (sheet 3)

One line, `data-testid="plan-progress-compact"`: **dot** (the marker's dot and colour) · step words
(≤ 28ch) · +N more · N of M authored · elapsed · last activity. With no step the **state word**
leads (_Starting…_ / _Being written_ / _Stalled_ / _Reconnecting_). No button, no popover, no pointer —
the row it sits in is the way into the plan. It reads the SAME derivation through the SAME
formatter as the pane form, so the two never disagree. The same drop order applies at narrow widths.

**What this Part does not draw for the row:** the row's title, target, planner name
(`Motir AI` / `{harness} · {model}`), its link and the tab itself — the Workbench tab item composes
this line into its row and owns the rest.

## 26.6 The DRAFTING cue (sheets 4–5)

**A layer on the shipped node box, never on the card.** The node box
(`[data-node-id]`, `absolute rounded-(--radius-card)`) gains `data-cue="drafting"` and two children:

- **ring** — `pointer-events-none absolute -inset-[7px] rounded-[calc(var(--radius-card)+7px)]
border-2 border-dotted border-(--el-status-in-progress)`, `aria-hidden`;
- **chip** — on the TOP edge, `absolute -top-[18px] left-3`, `pen-line` (size-3,
  `--el-status-in-progress`) + **Drafting**, `rounded-(--radius-badge)`,
  `px-(--spacing-chip-x) py-(--spacing-chip-y)`, `border --el-status-in-progress`, fill `--el-card`,
  `text-[11px]` semibold `--el-text-secondary`; `role="img"`, name _Being drafted now_,
  `data-testid="canvas-cue-drafting"`.

Because it never repaints the card it **composes with every Part VI op treatment** (the dashed accent
`add`, the info-ring `modify`, the struck `remove`) and with **Part XXIII's deepen**, whose 2px outline
at offset 2px sits inside the ring at 7px. Sheet 4 draws it on three adds, one modify and one remove
at once.

**It does NOT loop.** No pulse, no marching dots, no shimmer — a static mark, for four reasons:

1. **Part XXIII §23.1's precedent** — the live marker is static because a moving thing in a reading
   surface is an attention sink; a level authored in parallel would put SIX of them on screen at once.
2. **A loop runs on the client's clock** and so asserts liveness the server has not reported. During a
   dropped read (§26.10) or the minutes before a stall is declared, a pulsing cue would say "working"
   when nothing is known.
3. **The deepen is the motion.** The moment that matters — the item landing — already animates
   (§23.4). A looping cue would compete with the one motion that carries news.
4. **Reduced motion then needs no second design** (§26.8).

**Untargeted author (_Drafting a new item_) draws NOTHING on the canvas.** An item not yet appended
has no level and no cell: a placeholder would have to guess a level, would re-lay the level twice
(once for the ghost, once for the real card) and would add a second arrival motion. It appears only in
words; when it lands it ARRIVES by §23.3, and that arrival is its cue (sheet 4, right).

**A cue draws only where its target is ON the viewed level and ON the plan.** A step whose target was
withdrawn, or is not on the plan, draws nothing and is dropped from the words (sheet 9); a target on
another level is the pill's (§26.7).

## 26.7 The LAYING cue — three places (sheet 6), and off-level (sheet 7)

A lay step names a PARENT (or none, for the top level):

| where the parent is                    | mark                                                                                                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · a card on the viewed level**     | the same ring, `data-cue="laying"`, chip on the **BOTTOM** edge (`-bottom-[18px]`) — `list-tree` + _Laying its children_, name _Its children are being laid now_, `data-testid="canvas-cue-laying"` — the bottom, because that is where its children will hang |
| **2 · the level the reader is INSIDE** | a chip on the **current breadcrumb** (`data-testid="canvas-crumb-cue"`): `list-tree` + _Laying this level_                                                                                                                                                     |
| **3 · none — the project's top level** | the same chip on the **root crumb**: _Laying the top level_, wherever the reader stands                                                                                                                                                                        |
| any other level                        | the arrivals slot (below)                                                                                                                                                                                                                                      |

**Off-level — Part XXIII §23.7's ONE slot, re-worded; AMENDS §23.7's copy, not its behaviour.** No
second pill, no jump, the follow offer still wins the slot. The slot names in-flight steps on levels
the reader is not viewing, in this order of precedence:

| situation                                   | wording (key)                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| arrivals only (shipped)                     | `{count} new in {identifier} · Go there` (`arrivedIn`)                                     |
| author steps on ONE other level             | `{count} being drafted in {identifier} · Go there` (`draftingIn`)                          |
| a lay step on another level                 | `Laying {identifier} · Go there` (`layingIn`)                                              |
| arrivals AND author steps on the same level | `{arrived} new · {drafting} being drafted in {identifier} · Go there` (`newAndDraftingIn`) |
| author steps on several other levels        | `{count} being drafted elsewhere · first in {identifier} · Go there` (`draftingAcross`)    |
| reader outside the plan's scope             | the follow offer (shipped, MOTIR-6161) — wins                                              |

When arrivals and steps are on DIFFERENT levels, arrivals win the slot (they are news; steps are
state). **Go there** goes to the latest arrival's level, else the earliest in-flight step's level.

## 26.8 The interaction spec — motion

Same idiom as §23.4: CSS transitions in `app/globals.css`, gated behind
`@media (prefers-reduced-motion: no-preference)`; static form is the default. Easings are §23.4's two
constants, `--canvas-ease-enter` and `--canvas-ease-exit`.

| #   | change                                         | before → during → after (sheet)                                                 | what moves · property                                             | duration token          | easing       | reduced-motion form                            |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------- | ------------ | ---------------------------------------------- |
| C1  | a cue ARRIVES (step starts)                    | no mark → ring + chip at ½ → settled (5 ④⑤, 8)                                  | ring + chip `opacity 0 → 1`; ring `transform: scale(1.03) → none` | `--transition-slow`     | enter        | drawn in one frame, no scale                   |
| C2  | a cue LEAVES (step clears / ages out)          | settled → ½ → gone (5 ①②)                                                       | ring + chip `opacity 1 → 0`                                       | `--transition-duration` | exit         | removed in one frame                           |
| C3  | the planner MOVES to the next item             | C2 on the old card, then C1 on the new one (5 ①–⑤)                              | as C2, then C1 — **the cue never travels** between cards          | as C2 / C1              | exit → enter | both in one frame                              |
| C4  | a drafted item LANDS (its fields fill)         | cue → C2 → §23.4 DEEPEN (5 ③)                                                   | C2 first, then the shipped DEEPEN outline (held 600 ms, fade)     | C2, then §23.4          | exit, §23.4  | cue gone in one frame; §23.5's 1200 ms outline |
| C5  | a lay result lands                             | laying cue → C2 → §23.3 staging (arrivals) → C1 on newly drafted children       | as named                                                          | as named                | as named     | one frame                                      |
| C6  | a crumb chip arrives / leaves                  | as C1 / C2 (6 ②③)                                                               | chip `opacity`                                                    | as C1 / C2              | enter / exit | one frame                                      |
| C7  | the line's text changes (words, counts, times) | swapped in place                                                                | **nothing animates**                                              | —                       | —            | same                                           |
| C8  | stalled ↔ recovered                            | marker word + dot swap; cues C2 on stall, C1 on recovery (9)                    | the cues only; the marker is static (§23.1)                       | as C2 / C1              | exit / enter | one frame                                      |
| C9  | the pill's wording changes                     | swapped in place                                                                | nothing                                                           | —                       | —            | same                                           |
| C10 | hand-over (`planned` / `declined`)             | line, popover, pointer, cues gone in ONE frame; §23.13 for everything else (10) | nothing animates out — the plan is no longer being written        | —                       | —            | same                                           |

- **Several cues in one read stagger 40 ms, capped at 160 ms**, §23.4's arrival stagger, and they
  follow — never interleave with — that read's arrivals: exits (C2) → §23.4 exits / re-lays /
  arrivals → deepens → C1.
- **The cue is diffed by snapshot** like everything in §23.4: a (target, kind) pair that appears is
  C1, one that disappears is C2. A step whose `startedAt` changes but whose target does not is not a
  change.
- **A dropped read plays nothing** (§26.10).
- **Suggested class names** (the cue card settles them): `canvas-cue`, `canvas-cue--enter`,
  `canvas-cue--exit`, beside `.canvas-node--*` in `globals.css`.

**Reduced motion (sheet 8).** The cue is the SAME static marker with every fade removed. It is
distinguishable from §23.5's reduced-motion deepen without colour: the cue is a **dotted** ring with a
**labelled chip** that **stays for as long as the step**; the deepen is a **solid**
`--el-accent-on-surface` outline, **no label**, held 1200 ms and gone.

## 26.9 THE STALLED THRESHOLD — `PLAN_STALLED_AFTER_MS = 900_000` (15 min)

**One constant**, exported by MOTIR-7825 beside the derivation, read by every surface and by the
derivation's two uses of it:

1. **the plan is `stalled`** when `serverNow − lastActivityAt > PLAN_STALLED_AFTER_MS` (equal is not
   stalled; +1 ms is);
2. **a single step is dropped as quiet** when `serverNow − step.startedAt > PLAN_STALLED_AFTER_MS` —
   so the constant must ALSO exceed the longest normal single session.

**The story assumed 10 minutes. Measured, 10 minutes is too tight; 15 minutes is the number.**

**How it was measured (2026-10-08).** `Plan` / `PlanItem` carry no `updatedAt`, so the only gaps
readable today are between consecutive **proposal appends** (`PlanItem.createdAt`) and from the last
append to `plannedAt`. Read through the Motir MCP `get_plan` (item timestamps) and
`GET /api/v1/plans/{id}` (`createdAt` / `plannedAt`) on the live tenant, over **every plan id named
in the reachable record** — motir-meta's `audits/obsolescence/*.md` and motir-core's `docs/` —
**16 plans**:

| plan                        | author                                                                                                                           | proposals | created → planned (span)             | longest gap while `generating`                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------ | --------------------------------------------------- |
| `cmu1iamkg009rhutxld323mnw` | MCP · Claude Code · `claude-opus-5[1m]`                                                                                          | 16        | 17:17:55 → 17:32:01 (846 s)          | **582 s** (17:21:14 → 17:30:56)                     |
| `cmuiv4wdy002fhvoio4f2c2af` | MCP · Claude Code · `claude-opus-5-5`                                                                                            | 19        | 20:49:28 → 21:03:42 (855 s)          | **477 s** (then 107 s, 67 s)                        |
| `cmtdl09xr003jhvphju1lwjoy` | not in the read                                                                                                                  | 3         | 23:27:22 → 23:31:23 (240 s)          | ≤ 240 s                                             |
| `cmul8zc73…`                | obsolescence-audit plan                                                                                                          | small     | 92 s                                 | 51 s                                                |
| ten more small plans        | `cmt9dk0bs`, `cmt9dlzvg`, `cmtfw5tjr`, `cmul91f0u`, `cmul97twq`, `cmul98jow`, `cmul99aj6`, `cmul9af5n`, `cmul9hbal`, `cmul9ipf2` | 1–6       | 28–88 s                              | < 88 s                                              |
| `cmul9otyl…`                | obsolescence-audit plan                                                                                                          | small     | 6 s                                  | —                                                   |
| `cmt0nxdb600qni3phtsm1jpdp` | —                                                                                                                                | —         | **declined, never planned — 36.7 h** | the ABANDONED case: this is what stalled must catch |

(`cmul2odsj` was a 0-proposal dry run and is excluded; items appended to `cmu1iamkg` after it was
`planned` — 17:54 — are review revisions, excluded.)

**Result.** The longest normal quiet stretch observed is **582 s (9.7 min)** — inside a real
two-level walk, while the planner authored a level's children before appending them. A 10-minute
threshold leaves **3 % headroom** over that and would flash _Stalled_ on a healthy plan; the next plan
a little larger crosses it. **15 minutes is ≈ 1.55× the longest observed gap**, still catches the
abandoned plan within a quarter-hour, and also bounds the per-step quiet drop (2) for one long session.

**What the measurement could NOT see, so nobody reads it as more than it is:**

- the gaps are **upper bounds**: deepens and edits write no row with a timestamp today, so a planner
  that was writing (but not appending) inside a gap is invisible to this method;
- **no hosted Motir AI plan id** was reachable, and no `plan.py` run ledger with per-session durations;
  the two real walks are both MCP / Claude Code, and the small plans' author fields are not in the v1 read;
- `plan.py` sessions have no subprocess timeout, so nothing bounds a single session from above.

**So the constant is a measured starting point, not a law.** Once MOTIR-7822 stamps
`lastActivityAt` and step `startedAt`, the same query over real signals (longest
`lastActivityAt` gap per plan that reached `planned`, both planners) re-checks it; change the ONE
constant, never a surface.

## 26.10 The dropped read — AMENDS nothing in §23.10

Three failed polls → _Reconnecting — showing the last update_, exactly as shipped. Added: **the last
snapshot holds** — step words, counts, cues all stay as they were, nothing animates out (a failed read
is not news about the planner). Elapsed and last activity keep ticking from the snapshot's stored
times (they are facts about that snapshot), but **stalled is never computed client-side**: only a read
can declare it. The Reconnecting word wins over every other marker word. The compact form shows the
warning dot and the snapshot.

## 26.11 Stalled, and recovered

Stalled is the derivation's verdict (§26.9). On the canvas every step has aged out by then, so every
cue has left by C2 — **a stalled plan never shows anything as being drafted**. The marker reads
_Stalled_ with the `--el-warning` dot; the line shows counts, elapsed, _no activity for {duration}_;
the popover adds _Nothing has been written or reported for {duration}. The plan may have stopped._
**Recovery** is the next read that sees a later `lastActivityAt`: the marker returns to _Being
written_ and any new step's cue arrives by C1 (sheet 9). There is no resume or cancel control here
(story scope).

## 26.12 The hand-over — adds to §23.13

When the plan leaves `generating` (`planned`, `declined`, failed), in the **same frame** the shipped
marker leaves: the progress line, its popover (closed if open), the pointer, every cue and every crumb
chip leave too, with no exit motion (C10). Everything else is §23.13 / §23.12. A plan that leaves
`generating` leaves Workbench › Planning on the tab's next read (the tab item's).

## 26.13 Copy — `messages/en.json` AND `messages/zh.json`

The reader-facing noun is _item_ / 工作项, never _card_ (the catalogue guard).

| key                                          | en                                                                                  | zh                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `planReview.liveStarting`                    | Starting…                                                                           | 正在启动…                                                           |
| `planReview.liveStalled`                     | Stalled                                                                             | 已停滞                                                              |
| `planReview.progress.settling`               | Settling the conversation                                                           | 正在梳理对话                                                        |
| `planReview.progress.layingChildrenOf`       | Laying: {title}                                                                     | 正在铺设：{title}                                                   |
| `planReview.progress.layingTopLevel`         | Laying the project's top level                                                      | 正在铺设项目的顶层                                                  |
| `planReview.progress.authoring`              | Authoring: {title}                                                                  | 正在编写：{title}                                                   |
| `planReview.progress.draftingNew`            | Drafting a new item                                                                 | 正在起草一个新工作项                                                |
| `planReview.progress.moreSteps`              | +{count} more                                                                       | 另有 {count} 项                                                     |
| `planReview.progress.authored`               | {authored} of {proposed} authored                                                   | 已编写 {authored}/{proposed} 项                                     |
| `planReview.progress.elapsedUnderMinute`     | <1 min                                                                              | 不到 1 分钟                                                         |
| `planReview.progress.elapsedMinutes`         | {minutes} min                                                                       | {minutes} 分钟                                                      |
| `planReview.progress.elapsedHours`           | {hours} h {minutes} min                                                             | {hours} 小时 {minutes} 分钟                                         |
| `planReview.progress.lastActivityJustNow`    | last activity just now                                                              | 刚刚有活动                                                          |
| `planReview.progress.lastActivitySeconds`    | last activity {seconds} s ago                                                       | 最近活动 {seconds} 秒前                                             |
| `planReview.progress.lastActivityAgo`        | last activity {duration} ago                                                        | 最近活动 {duration}前                                               |
| `planReview.progress.stalledFor`             | no activity for {duration}                                                          | 已 {duration} 无活动                                                |
| `planReview.progress.detailsAria`            | Plan progress details                                                               | 计划进度详情                                                        |
| `planReview.progress.detailsNow`             | Working on now                                                                      | 当前进行中                                                          |
| `planReview.progress.detailsNoSteps`         | No step reported — the planner may not report its steps.                            | 未报告步骤 — 该规划器可能不报告其步骤。                             |
| `planReview.progress.detailsStarted`         | Started {time} · running {duration}                                                 | 开始于 {time} · 已运行 {duration}                                   |
| `planReview.progress.detailsLastActivity`    | Last activity {time}                                                                | 最近活动于 {time}                                                   |
| `planReview.progress.detailsStalled`         | Nothing has been written or reported for {duration}. The plan may have stopped.     | 已 {duration} 没有写入或报告。计划可能已停止。                      |
| `planReview.progress.pointer`                | Follow from Workbench                                                               | 在工作台跟进                                                        |
| `planReview.progress.pointerSentence`        | You can leave — this plan keeps being written. Follow it from Workbench › Planning. | 你可以离开 — 此计划会继续编写。可在“工作台 › 规划”中跟进。          |
| `planReview.cue.drafting`                    | Drafting                                                                            | 起草中                                                              |
| `planReview.cue.draftingName`                | Being drafted now                                                                   | 正在起草                                                            |
| `planReview.cue.laying`                      | Laying its children                                                                 | 正在铺设子项                                                        |
| `planReview.cue.layingName`                  | Its children are being laid now                                                     | 正在铺设其子项                                                      |
| `planReview.cue.layingHere`                  | Laying this level                                                                   | 正在铺设此层级                                                      |
| `planReview.cue.layingTop`                   | Laying the top level                                                                | 正在铺设顶层                                                        |
| `planningWorkspace.arrival.draftingIn`       | {count} being drafted in {identifier} · Go there                                    | {identifier} 中有 {count} 项正在起草 · 前往                         |
| `planningWorkspace.arrival.layingIn`         | Laying {identifier} · Go there                                                      | 正在铺设 {identifier} · 前往                                        |
| `planningWorkspace.arrival.newAndDraftingIn` | {arrived} new · {drafting} being drafted in {identifier} · Go there                 | {identifier} 中有 {arrived} 项新内容 · {drafting} 项正在起草 · 前往 |
| `planningWorkspace.arrival.draftingAcross`   | {count} being drafted elsewhere · first in {identifier} · Go there                  | 其他层级有 {count} 项正在起草 · 首个在 {identifier} · 前往          |

**Reused verbatim:** `planReview.liveWriting`, `planReview.liveReconnecting`,
`planReview.liveAnnounce`, `planningWorkspace.arrival.arrivedIn` / `arrivedAcross` / `goToTarget`.
`{title}` is the target's title (a proposal's or a committed work item's); `{duration}` is formatted
by the elapsed keys; `{time}` by the reader's locale. `Workbench` / `Planning` follow the shipped
catalogue's 工作台 / 规划. The `{count}` keys take no plural form in either language, for §23.14's
reason.

## 26.14 a11y — what is live, and what is not

| element                     | role / live                                                         | what it announces                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| live marker (shipped)       | `role="status"`, `aria-live="polite"`                               | **only the state word's changes**: Starting… → Being written → Stalled → Being written; Reconnecting                                                      |
| arrivals announce (shipped) | sr-only `role="status"`                                             | §23.15 unchanged: `liveAnnounce`, once per batch                                                                                                          |
| progress button             | `<button aria-expanded aria-controls>` — **NOT live**               | nothing; read on focus (its text is its name). Step changes, counts and ticking times are never announced — six sessions would announce every few seconds |
| details popover             | `role="dialog"`, `aria-label` = `detailsAria`                       | nothing; focus moves in on open and back to the button on close (the shipped `Popover`)                                                                   |
| pointer                     | `<a>`, `aria-label` = `pointerSentence`                             | nothing                                                                                                                                                   |
| drafting / laying chip      | `role="img"` with `draftingName` / `layingName`; ring `aria-hidden` | nothing; read with the node when the canvas walks focus to it                                                                                             |
| crumb chip                  | text inside the crumb's `<li>`                                      | nothing; read with the breadcrumb                                                                                                                         |
| arrivals pill (re-worded)   | `<button>` (shipped)                                                | nothing; its text is its name                                                                                                                             |
| compact line                | plain text inside the row — **NOT live**                            | the Workbench tab's own count is the tab's concern                                                                                                        |

**Not colour alone:** the cue is a dotted ring + a labelled chip; stalled is a word, not just the
warning dot.

## 26.15 Token and shape roles

| element          | colour (`--el-*`)                                                                                   | shape                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| marker dot       | `--el-status-in-progress` (starting, writing) · `--el-warning` (stalled, reconnecting)              | `size-1.5`, `--radius-badge` (shipped)                                            |
| progress button  | `--el-text-secondary`; step words `--el-text`; hover / open `--el-surface-soft`                     | `--height-control`, `--spacing-control-x`, `--radius-control`                     |
| popover          | `--el-page-bg`, `--el-border`, `--el-border-soft` divider; text `--el-text` / `--el-text-secondary` | shipped `Popover`: `--radius-card`, `--shadow-elevated`, `--spacing-card-padding` |
| pointer          | `--el-link`                                                                                         | `--radius-control` focus box                                                      |
| cue ring         | `--el-status-in-progress`, dotted 2px                                                               | `calc(var(--radius-card) + 7px)`                                                  |
| cue / crumb chip | border + glyph `--el-status-in-progress`, fill `--el-card`, text `--el-text-secondary`              | `--radius-badge`, `--spacing-chip-x/y`                                            |

`--el-text-muted` and `--el-text-faint` carry nothing new. **For the cue item to measure:** the ring is
a non-text mark on `--el-canvas` and owes 3:1 in every palette × theme; the chip's text carries the
meaning, so a palette where the ring misses 3:1 degrades to a still-labelled chip, but the cue item
measures it before shipping and, if it fails, adds an `--el-cue` token rather than inventing a hue.

## 26.16 How the asset was produced

- Every pane, header, card, edge, breadcrumb and pill is the real components' DOM, rendered through
  `tests/helpers/renderWithIntl.tsx` in happy-dom on `origin/main` @ `066fb94`, with the roadmap
  read stubbed as the plan-review-canvas suites stub it: an epic MOTIR-6010 → stories MOTIR-7782
  (done) and MOTIR-7820 → committed MOTIR-7821 / -7822 / -7819, and the proposals A–E + a modify of
  MOTIR-7822 + a remove of MOTIR-7819 arriving around them. Thirteen renders (starting, full, early
  ×2, withdrawn, epic level, failing, planned, discarded, two pill states, follow offer, reduced
  motion). The harness was temporary and is not committed.
- The NEW layers (§26.0) are spliced into those renders; a "during" frame is the real render with the
  cue's inline `opacity` / `transform` at the transition's midpoint. The world transform is set per
  frame to frame the cards; the dependency legend is drawn COLLAPSED (a real state), as in §23.17.
- The first stylesheet is Tailwind v4.3.0's output compiled over this document's class attributes with
  `@motir/design-system/theme.css`; the second is the board chrome (`--el-*` only), with `.seg-ic`
  declared presentation-free for Part XXI 21.9's reason.
- Every lucide glyph is a `<symbol>` in one sprite with its provenance comment;
  `node scripts/audit-mock-sprites.mjs … --strict`: **25 symbols, 0 undeclared, 0 drifted** against
  `lucide-react@1.16.0`. New glyphs: `pen-line`, `list-tree`, `arrow-up-right`, `chevron-down`.
- It was rendered and looked at in headless Chromium, sheet by sheet.

## 26.17 GIVES / TAKES

- **MOTIR-7820** (the story) — neither; the container.
- **MOTIR-7822** (steps + `lastActivityAt`) — **TAKES** nothing from here but the step kinds' names it
  already has; **GIVES** this Part its inputs.
- **MOTIR-7825** (the ONE derivation) — **GIVES** the states, the order, the drop rules and
  `serverNow`; **TAKES** from here **`PLAN_STALLED_AFTER_MS = 900_000`** (§26.9), the "earliest step in
  words" order (§26.3) and the formats (§26.4) if it owns the formatter.
- **The progress-line item** — **TAKES** §26.1–26.5, 26.10–26.14.
- **The cues item** — **TAKES** §26.6–26.8, 26.15's measurement note.
- **The Workbench Planning tab item** — **TAKES** §26.5's compact line, composed into its row.
- **The emitter items (motir-ai walk, `plan.py`)** — neither; they write steps, they draw nothing.
- **The E2E / acceptance item** — **TAKES** the `data-testid`s: `plan-progress`,
  `plan-progress-steps`, `plan-progress-pointer`, `plan-progress-compact`, `canvas-cue-drafting`,
  `canvas-cue-laying`, `canvas-crumb-cue`, and `data-cue` on the node box.

## 26.18 What Part XXVI does NOT draw or decide

- The Workbench tab, its count, its rows' title / target / planner, its empty state, its place in the
  strip — the tab item's (the story fixes the place: right after the first tab, never a landing rung).
- A cue in the **List** view. The list's rows already change in place as items land (§23.9); the
  steps are in the header line above it. If a list cue is wanted, it is a new delta.
- Any pause, cancel, ETA or percentage (story scope).
- A notification when a plan is proposed.

**Amended for the drafting cue's colour and motion (MOTIR-8414, 2026-10-14):** `design/ai-chat/design-notes.md` § _⭐ Motir at work — the drafted card turns warm orange, pops and breathes, and one Motir mark in the rail breathes with it_ (`design/ai-chat/planning-workspace--at-work.mock.html`) gives the drafted card its own colour (`--el-drafting` / `--el-drafting-surface`, Motir's warm orange and peach), makes it pop and breathe while Motir is at work, and amends §26.6 and §26.8 C2 / C8 / C10 for that cue; read the two together.

# Part XXVII — a plan RESUMED BY ITSELF after its machine was lost: the _Resuming_ state of the progress line, its tail, its popover, its rail line, and when it turns _Stalled_ (MOTIR-8306 · Story MOTIR-8301 — `plan-review--live-progress--resuming.mock.html`, DATED 2026-10-12)

**Design system — the files read and the verdict.** `package.json` depends on
`@motir/design-system` (`workspace:*`, installed `0.13.0`), and `app/globals.css` imports
`@motir/design-system/theme.css`. **Verdict: on Motir Design (branch a).** The project's axes come
from the root layout's `data-style` / `data-palette` / `data-type` (`app/layout.tsx`, from the
reader's applied appearance); the mock draws the defaults the shipped progress-line mock drew. The
package exports `@motir/design-system/mock`, but **every part on this surface is product-local**, so
the mock composes those components' markup over the package's `theme.css` exactly as Part XXV's
asset did:

| part                                       | kind                    | reason                                                |
| ------------------------------------------ | ----------------------- | ----------------------------------------------------- |
| `PlanProgressLineView` (pane and compact)  | product-local component | the plan's progress line; nothing generic about it    |
| `PlanProposalViews`' pane header           | product-local component | the strip the line sits in                            |
| `PlanActRecord` (the rail's act record)    | product-local component | the planning rail's own record                        |
| `Popover` surface (`data-surface=popover`) | product-local primitive | `components/ui/Popover`, already composed by the line |

No part is proposed as an addition to `@motir/design-system`.

**The number.** Part XXIV is MOTIR-6628's published result, not landed here. Part XXV is used twice
already: MOTIR-7821's published live-progress design calls itself Part XXV, and this file's Part XXV
is MOTIR-5248's _Approve, while it runs_. motir-core#3545 (MOTIR-8299, open when this was written)
lands MOTIR-7821's design in this file as **Part XXVI**. This Part therefore takes **XXVII**. Below,
**"the progress design"** means MOTIR-7821's published result and its sections are cited by their
published numbers (§25.1–25.18), which #3545 renumbers to §26.x.

**A DELTA.** Base: the progress design, `ai-planning/plan-review--live-progress.mock.html` (a
published result, not in this checkout — paths relative to `design/` per the note above Part XXII's
successor sections). It is not edited. Composed unchanged: MOTIR-7907's
`design/workbench/workbench--planning-session-needs-you.mock.html` (the To resume entry) and
`design/ai-chat/planning-workspace--waiting-on-you.mock.html` (the overlay's _failed, waiting to
resume_ state with Resume).

## 27.1 What this Part adds

Story MOTIR-8301 makes core start the shipped Resume (MOTIR-7916) **by itself** when a hosted `plan`
job is reaped as abandoned (motir-ai's `ai_job_abandoned`, read in core as the lost-machine fact,
MOTIR-8304) and its plan already holds a proposal. The new job then waits to be claimed by another
machine, and during that wait nothing writes. Without this Part the line would read _Being written_
over a plan that is doing nothing. This Part adds:

1. **ONE marker state, `resuming`** — the fifth value of `MarkerState`, on the pane form, the
   compact form and the rail (Sheets 1, 5, 6).
2. **The tail while resuming** — a reason segment, an optional _second attempt_ segment, the counts
   and times unchanged (Sheet 1).
3. **The popover while resuming** — one sentence and a _Resumed automatically at_ row (Sheet 2).
4. **The rail's one narration line** — an act row, and what the rail must NOT show (Sheet 6).
5. **The stall rule for a resuming plan** (§27.5, Sheet 3), the dropped read (Sheet 4), the narrow
   widths (Sheet 7), dark and zh (Sheet 8).

It adds no route, no control, no motion and no notification. A person cannot cancel an automatic
resume from here (story scope).

## 27.2 Every panel is labelled `marker state · surface · density`

| marker (`MarkerState`) | word (en / zh)                         | dot                       | when                                                                                  | sheets  |
| ---------------------- | -------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- | ------- |
| `writing`              | Being written / 正在编写               | `--el-status-in-progress` | shipped                                                                               | 1, 3, 5 |
| **`resuming`**         | **Resuming / 正在继续**                | `--el-status-in-progress` | Motir resumed the plan by itself and the new job has written and reported nothing yet | 1–8     |
| `stalled`              | Stalled / 已停滞                       | `--el-warning`            | shipped — for a resuming plan, 15 min after the resume (§27.5)                        | 3, 5    |
| `reconnecting`         | Reconnecting — showing the last update | `--el-warning`            | shipped — wins over `resuming` as over everything (`markerOf`)                        | 4       |
| `starting`             | Starting…                              | `--el-status-in-progress` | shipped — **never follows a resume**: a resume needs a saved proposal                 | —       |

**Precedence (`markerOf`), extended by one rung:** `failing → reconnecting`, then `stalled`, then
**`resuming`**, then `starting`, else `writing`. `stalled` outranks `resuming` because a resume
nobody claimed for 15 minutes is a stall, and saying _Resuming_ forever would hide it.

**Why the in-progress role, not the warning role.** _Stalled_ and _Reconnecting_ wear `--el-warning`
because each says "something may be wrong, look". Resuming says the opposite: something went wrong,
Motir already handled it, and there is nothing for the person to do. A warning dot would call them
to act on a state that needs no act and that usually lasts seconds. The word carries the news, and
the reason segment carries the cause (§25.14's _not colour alone_ holds).

**The word.** _Resuming_ in en. In zh **正在继续**, not 正在恢复: the shipped catalogue translates
_resume_ as 继续 everywhere a person meets it (`workbench.planningSession.resume` 继续,
`resuming` 正在继续…, `waitingToResume` 待继续), and a second verb for the same act would read as a
different act. The automatic state drops the ellipsis that the manual button's in-flight label
carries, because it is a state, not a pressed control.

## 27.3 The line's tail while resuming (Sheets 1, 2, 5)

**Order:** `[marker] [reason] [· second attempt] [· N of M authored] [· elapsed] [· last activity]`.

- **The step words are absent.** No session is running, so the derivation returns no live step.
- **The reason segment, `planReview.progress.resumingReason`**: _picking up where it stopped_ /
  从中断处接着写. `text-xs --el-text-secondary`, not tabular, `data-testid="plan-progress-reason"`. It
  says what is happening in the person's terms. The cause (_lost its machine_) is in the popover and
  the rail, because the marker plus a short reason is what fits a row.
- **The second automatic attempt, `planReview.progress.resumingSecond`**: _second attempt_ /
  第二次尝试, a segment right after the reason, only when the session's automatic-resume count is 2.
  The words are the shipped _Second attempt_ pill's (`workbench.planningSession.second`), so one event
  is not named two ways. There is no third (§27.7).
- **N of M authored, elapsed, last activity — unchanged.** N of M is kept: the saved proposals are on
  the plan. Elapsed keeps ticking from `Plan.createdAt`. **Last activity reads _just now_ at the
  resume** because the resume's bind stamps `Plan.lastActivityAt` (`planRepository.repointSourceJob`,
  "so the resumed plan does not read as stalled before its first signal"), and then ticks by §25.4.
- **The compact form:** the state word leads (no step is in words), then the same tail (Sheet 5).

**Narrow widths — §25.2's drop order, with the new segments in front (Sheet 7).** The reason and the
_second attempt_ segment drop FIRST (below 50rem of header width), then last activity (below 45rem),
then elapsed and the pointer (below 35rem). Counts never drop. Implement it on the header's own width,
as §25.2 says. The compact row drops in the same order.

## 27.4 The popover while resuming (Sheet 2)

The shipped `Popover` and its layout. While resuming:

- **The eyebrow** reads `planReview.progress.detailsResumingHead` (_Picking up where it stopped_)
  instead of _Working on now_, because there is no step to list.
- **In place of the step list, ONE sentence**, `planReview.progress.detailsResuming`,
  `text-sm --el-text`, `data-testid="plan-progress-resuming"`: _The machine writing this plan was
  lost. Motir started the plan again by itself, and it continues from where it stopped — the items
  already written are kept and are not written again._
- **The facts block** is the shipped one (counts, _Started … · running …_, _Last activity …_) with ONE
  new row between _Started_ and _Last activity_: `planReview.progress.detailsResumedAt`, _Resumed
  automatically at {time}_ (`HH:mm:ss`, §25.4's clock format), or `detailsResumedAtSecond`, _Resumed
  automatically at {time} · second attempt_. `data-testid="plan-progress-resumed-at"`.
- **The pointer sentence stays**, with its link.

**The resumed-at row outlives the state.** It is shown whenever the session has an automatic resume
and the plan is still `generating` — on _Being written_ and _Stalled_ after a resume too (Sheet 3) —
because "when did Motir pick this up" is exactly what a person reading a stalled plan wants to know.

## 27.5 THE STALL RULE for a resuming plan — the ONE shipped threshold, from the resume's instant

**Rule:** a resuming plan turns _Stalled_ when `serverNow − (the automatic resume's instant) >
PLAN_STALLED_AFTER_MS` (900 000 ms, §25.9). No second constant.

**Why from the resume, not from the last write before the machine died.** The machine dies at some
point after the plan's last write; the lease then has to lapse and the reap has to be read before
core resumes. Measured from the last write, a plan whose last write was 14 minutes before the death
would read _Stalled_ a minute after Motir picked it up, which is false: the new job has had one
minute, not fifteen.

**It needs no new comparison today.** The resume's bind stamps `Plan.lastActivityAt` at the
resume (§27.3), and the shipped derivation measures stalled from `lastActivityAt`. So the shipped rule
already measures from the resume's instant, provided the automatic path goes through the shipped bind.
The progress-state card keeps it that way, and its test pins it: _resume at T, no signal; at
T + 15 min the plan reads `resuming`, at T + 15 min + 1 ms `stalled`_.

**Transitions (Sheet 3):** _Resuming_ → _Stalled_ past the threshold, with the shipped stalled tail
(_no activity for 15 min_) and the shipped stalled sentence; _Stalled_ → _Being written_ on the next
read that sees a later `lastActivityAt` (the shipped recovery, §25.11).

## 27.6 Hand-over out of Resuming (Sheet 1)

- **The new job's first signal** (a step): the marker turns _Being written_ and the step words return
  through the shipped phrases. N of M is unchanged.
- **A first proposal write with no signal** (a planner that does not report steps): the marker turns
  _Being written_ in the shipped _writing_ form (no step words, the counts move).
- **When `resuming` holds, stated for the card that computes it.** The plan is `generating`, its
  session is open and not failed, the session has an automatic resume on record, and **nothing has
  been signalled or written since that resume**: no step started after it, and `lastActivityAt` has
  not moved past the resume's own stamp. The cleanest way to make the last clause exact is to record
  the automatic resume's instant with the SAME instant the bind stamps on the plan (see §27.8's
  finding 2).

## 27.7 The rail (Sheet 6)

**One quiet narration line, an act row in `PlanActRecord`:** glyph `rotate-ccw` (lucide, new to this
area), mono label `planningWorkspace.conversation.act.resumed` (_resume_ / 继续), line
`act.resumedLine` (_Lost its machine — Motir started it again and it picks up where it stopped_), or
`act.resumedLineSecond` for the second. `data-testid="plan-change-act-resumed"`. Same ink as every act
row (`--el-text-secondary`; the glyph `--el-text-secondary`), the record's `--el-surface-soft`
fill. It is ordinary record content: no spinner, not live, not `role="alert"`, no button. The new
job's acts append below it.

**What the rail must NOT show while an automatic resume is in flight:** MOTIR-7907's failure block
(_This attempt stopped_, the reason, _Waiting to resume_, **Resume**; `FailedWaitingNotice`). Its
condition is the session's failure record, which the bind clears; so it is absent by the shipped
rule, provided the record is cleared before a read can see it (§27.8's finding 1).

**The bound used (Sheet 6, composed).** The third lost machine on one session finds
`recordAutoResume` refused (`AUTO_RESUMES_PER_SESSION = 2`), so the failure stays recorded like any
other. Everything that follows is MOTIR-7907's, unchanged: the plan leaves Workbench › Planning by its
shipped leave frame (MOTIR-7907's amendment of MOTIR-7823's), lands in To resume, and the rail shows
_This attempt stopped_ with _Second attempt_ and Resume (`FailedWaitingNotice`, `failed-again`). The
marker leaves _Resuming_ on the next read.

**Never _Resuming_:**

- **Nothing saved** — the machine is lost before the first proposal. Nothing resumes it
  automatically; it fails exactly as today.
- **Not a lost machine** — a judged failure (rate limit, credits, prompt too large, …), a cancel or a
  stop. Never resumed automatically.
- **Other planners and jobs** — `plan.py` and MCP-authored plans, and `revise_plan` / `generate_tree`
  jobs. Nothing resumes them automatically, so they never read _Resuming_.

## 27.8 List membership — checked against the reads, and two findings

**A resuming plan STAYS in Workbench › Planning.** Membership is
`planRepository.generatingRequestedByWhere`, read by both `workbenchPlanningService.listMyPlansBeingWritten`
and the tab's badge; it carves out a FAILED plan through `FAILED_WAITING_WHERE` (MOTIR-7914). A
resuming plan is `generating` and its session's failure record has been cleared by the bind
(`planSessionResumeService`'s `bind` → `planChangeSessionRepository.clearFailure`), so it is listed.

**A resuming plan is NOT in To resume.** `homeService.listToResume` lists the owner's open sessions
with a failure on record (`countFailedOpenForOwner` / `listFailedOpenForOwner`). The cleared record
keeps it out.

**Finding 1, for the auto-resume card (MOTIR-8307): a window where both reads say "failed".** The
shipped Resume submits FIRST and binds SECOND (`planSessionResumeService`: "the SUBMIT comes first …
and the BIND second"), and the failure record is written before either, by `settleFailedJob` or the
sweep. Between the failure write and the bind's `clearFailure` — one motir-ai submit round trip —
the plan is out of Planning and in To resume, and a poll landing there would draw MOTIR-7907's
failure block with Resume for one frame. Not drawn around here: the auto-resume card either keeps the
window from being observable or states that the one-poll flash is accepted. A submit that is
REFUSED (out of credits, rate limited, motir-ai unreachable) leaves the record in place, which is
right: that plan does need its person.

**Finding 2, for the auto-resume card and the progress-state card (MOTIR-8309).** The cleanest
`resuming` test is "the plan's `lastActivityAt` equals the session's `lastAutoResumedAt`", which holds
only if the automatic resume is recorded in the bind's own transaction with the bind's own instant.
Recording it earlier (to reserve the bound before the submit) leaves the two instants milliseconds
apart and forces the derivation into a tolerance. Recommended: record it inside the bind, with the
same `now`.

## 27.9 Copy — `messages/en.json` AND `messages/zh.json`

| key                                                    | en                                                                                                                                                                                     | zh                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `planReview.liveResuming`                              | Resuming                                                                                                                                                                               | 正在继续                                                                                                |
| `planReview.progress.resumingReason`                   | picking up where it stopped                                                                                                                                                            | 从中断处接着写                                                                                          |
| `planReview.progress.resumingSecond`                   | second attempt                                                                                                                                                                         | 第二次尝试                                                                                              |
| `planReview.progress.detailsResumingHead`              | Picking up where it stopped                                                                                                                                                            | 从中断处接着写                                                                                          |
| `planReview.progress.detailsResuming`                  | The machine writing this plan was lost. Motir started the plan again by itself, and it continues from where it stopped — the items already written are kept and are not written again. | 编写此计划的机器丢失了。Motir 已自动重新开始此计划，它会从中断处继续 — 已写好的工作项会保留，不会重写。 |
| `planReview.progress.detailsResumedAt`                 | Resumed automatically at {time}                                                                                                                                                        | 已于 {time} 自动继续                                                                                    |
| `planReview.progress.detailsResumedAtSecond`           | Resumed automatically at {time} · second attempt                                                                                                                                       | 已于 {time} 自动继续 · 第二次尝试                                                                       |
| `planningWorkspace.conversation.act.resumed`           | resume                                                                                                                                                                                 | 继续                                                                                                    |
| `planningWorkspace.conversation.act.resumedLine`       | Lost its machine — Motir started it again and it picks up where it stopped                                                                                                             | 机器丢失 — Motir 已重新开始，从中断处继续                                                               |
| `planningWorkspace.conversation.act.resumedLineSecond` | Lost its machine again — second automatic attempt, picking up where it stopped                                                                                                         | 机器再次丢失 — 第二次自动尝试，从中断处继续                                                             |

**No string names an internal code**: never _lease_, _reaped_, _abandoned_ or `ai_job_abandoned`.
The person's terms are _the machine was lost_ and _picking up where it stopped_. The reader-facing
noun stays _item_ / 工作项. Reused verbatim: every key of §25.13, and
`workbench.planningSession.second`'s wording (copied, not referenced, so the line does not depend on
the Workbench namespace).

## 27.10 a11y — what is live

| element                         | role / live                         | what it announces                                                                                  |
| ------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| marker (shipped)                | `role="status"`, `aria-live=polite` | its WORD only: _Being written → Resuming → Being written_, once each; never a tick or the reason   |
| reason / second-attempt segment | plain text inside the button        | nothing; read with the button on focus                                                             |
| popover sentence and row        | inside the shipped dialog           | nothing; read on open                                                                              |
| rail act row                    | record content in the `role="log"`  | the act record's own sr-only announcer says its line once, when the row is appended (shipped rule) |
| compact line                    | plain text — NOT live               | nothing                                                                                            |

## 27.11 Token and shape roles

| element          | colour (`--el-*`)                                                  | shape                                       |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| resuming dot     | `--el-status-in-progress` (§27.2)                                  | `size-1.5`, `--radius-badge` (shipped)      |
| reason segment   | `--el-text-secondary`                                              | inside the shipped progress button          |
| popover sentence | `--el-text` on `--el-page-bg`                                      | shipped `Popover`                           |
| resumed-at row   | `--el-text-secondary`                                              | shipped facts block                         |
| rail act row     | `--el-text-secondary` glyph, label and line on `--el-surface-soft` | shipped `--radius-card` record, `px-3 py-2` |

`--el-text-muted` and `--el-text-faint` carry nothing new.

## 27.12 How the asset was produced

- Every strip is the markup of `PlanProposalViews`' pane header, `PlanProgressLineView` (both
  densities) and `PlanActRecord`, written class for class from the component source on the parent
  branch `parent/MOTIR-8301-auto-resume-lost-machine` and from the DOM MOTIR-7821's published mock
  carries; the new state is spliced in. The Segmented's markup is that mock's, verbatim.
- The first stylesheet is Tailwind v4's output (`@tailwindcss/postcss`) compiled over this document's
  class attributes with `@motir/design-system/theme.css`; the second is Part XXV's board chrome
  (`--el-*` only) plus three host classes. The dark panels use `data-theme="dark"` with
  `data-appearance-scope`, so the Tier-3 layer re-resolves in the nested scope.
- Every glyph is a `<symbol>` extracted from `lucide-react@1.16.0`'s `__iconNode`:
  `node scripts/audit-mock-sprites.mjs … --strict` reports **9 symbols, 0 undeclared, 0 drifted**.
  New to the area: `rotate-ccw`.
- Rendered in headless Chromium and looked at sheet by sheet.

## 27.13 GIVES / TAKES

- **MOTIR-8301** (the story) — neither; the container.
- **MOTIR-8304** (core reads the lost-machine fact) — **GIVES** the fact this state depends on;
  TAKES nothing.
- **MOTIR-8305** (the session's automatic-resume record) — **GIVES** `autoResumeCount` and
  `lastAutoResumedAt`, which decide `resuming` and _second attempt_; TAKES nothing.
- **MOTIR-8307** (resume a lost machine's plan automatically) — **TAKES** findings 1 and 2 (§27.8):
  the visible window between the failure write and the bind, and recording the resume with the
  bind's instant. Its estimate still fits: both are choices about where an existing write sits.
- **MOTIR-8309** (a plan resumed automatically reads "resuming") — **TAKES** §27.2–27.7 and §27.9–27.11:
  the fifth `MarkerState`, its precedence, the tail, the popover, the rail row, the copy and the stall
  test of §27.5. Re-checked against what it is handed: the derivation gains one state from two fields
  it can read, and the view gains one word, two segments, one popover branch and one act row. It
  still fits its estimate; the one risk is the rail row's data source (the act record is fed by the
  stream, and the row has to come from the session's record so a reload draws it too), which that
  card should name.
- **MOTIR-8310 / MOTIR-8311** (the integration and E2E cards) — **TAKE** the `data-testid`s:
  `plan-live-state` with `data-state="resuming"`, `plan-progress-reason`, `plan-progress-resuming`,
  `plan-progress-resumed-at`, `plan-progress-compact` with `data-state="resuming"`,
  `plan-change-act-resumed`; and, for the acceptance video, Sheet 1's _Being written → Resuming →
  Being written_ path. Their estimates still fit.
- **MOTIR-7907** — **TAKES nothing.** Its _resuming (held)_ To resume row and its _Resuming…_ button
  stay the MANUAL Resume's, unchanged.
- **MOTIR-7916 / MOTIR-7914 / MOTIR-8128** — read, not changed: the resume's bind, the membership
  reads, and the silence sweep.
- **MOTIR-7821 / MOTIR-8299** — the base design and the card landing it as Part XXVI; neither.
- **MOTIR-7823** — its leave frame (as MOTIR-7907 amended it) is composed for the bound-used case;
  neither.

## 27.14 What Part XXVII does NOT draw or decide

- Computing `resuming` (MOTIR-8309), when an automatic resume starts and its bound (MOTIR-8305,
  MOTIR-8307), keeping the silence sweep off a resuming plan (MOTIR-8307).
- MOTIR-7907's manual-resume states, the To resume entry, any change to the step words or to _N of M_.
- A notification, a cancel control, an ETA.
- The minutes between a machine dying and its job being reaped: the line reads as it does today
  (_Being written_, and _Stalled_ if the last write was long enough ago), because nothing knows yet.

---

# Part XXVIII — FOLLOWING THE PLANNER on the overlay canvas, and fields that TYPE IN in the proposal quick view (MOTIR-8591 · Story MOTIR-8590 — `plan-review--follow-the-planner.mock.html`, DATED 2026-10-15)

**Design system, identified first.** Read `package.json` (depends on `@motir/design-system`,
`workspace:*`) and `app/globals.css` (line 13, `@import '@motir/design-system/theme.css'`). Both hold,
so the verdict is **(a) ON MOTIR DESIGN**, package **v0.15.1** (`packages/design-system/package.json`).
The project's axes are per person (`app/layout.tsx` stamps the reader's `data-style` / `data-palette`
/ `data-type`; a signed-out reader gets none), so the board renders at the package defaults
(`warm-editorial` · `motir` · `motir`), which is what a Visitor sees. The package exports
`@motir/design-system/mock`, and the board is built with its `renderMock`. Every part on this surface
is product-local, so the board composes those parts' **real emitted markup**:

| part                                                                                   | kind                    | reason                                                                              |
| -------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `PlanProposalViews` → `PlanReviewCanvas` → `ProjectRoadmapCanvas` (the breadcrumb bar) | product-local component | the planning canvas pane and its bar, where the control lives                       |
| `PlanProgressLineView` (the pane header)                                               | product-local component | the progress line, cited and not changed                                            |
| `IssueQuickViewPanel` in proposal mode (opened by `ProposalPeek`)                      | product-local component | the Part XIV peek, where fields type in                                             |
| the follow control (`canvas-follow-state` / `canvas-follow-planner`)                   | product-local component | NEW, composed from the shipped follow offer's markup; nothing to add to the package |
| the typing copy (`data-typewriter`)                                                    | product-local component | NEW, a wrapper around the peek's own field elements                                 |

Nothing is proposed for `@motir/design-system`. One product-local token is added (§28.6).

**The number.** _Part XXVIII_ is free. Checked on 2026-10-15 against this file's index (Part XXVII,
MOTIR-8306, is the last row) and its headings (`grep -n "^# Part" design-notes.md`: XXVII is the last),
and against the area's published results (`list_designs { projectKey: "MOTIR", pathPrefix:
"design/ai-planning/" }`, paged to the end: the newest is MOTIR-8306's Part XXVII, MOTIR-6628's
published result holds XXIV, and nothing is published past XXVII).

**A DELTA.** Base: `plan-review--live-drawing.mock.html` (Part XXIII, the generating pane) and
`peek-proposal-mode.mock.html` (Part XIV, the proposal quick view). Neither mock is edited. Neighbour,
drawn but not changed: the drafted card's orange cue, pop and breath (`design/ai-chat/design-notes.md`
§ _Motir at work_, MOTIR-8414, shipped by MOTIR-8413 in motir-core#3588).

**Asset:** [`plan-review--follow-the-planner.mock.html`](./plan-review--follow-the-planner.mock.html).

| Panel  | What it shows                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------ |
| A1–A12 | Table A, one panel per row, each with the four trips it offers                                   |
| B1–B4  | The driven move: old level → crossfade → new level, then two moves one poll apart on a time axis |
| C0     | The access path to the quick view (a card on the canvas)                                         |
| C1–C6  | Table C: empty at open, arrival and typing, several fields in order, the long body, at once, AT  |
| D1–D2  | Dark: A1, A4, A6, B3, the compact button, C3 and C1                                              |

## 28.0 Rendered before drawn

Every pane is the emitted markup of `PlanProposalViews` with `live`, `preserveCanvasLevel` and a
progress snapshot, and every peek the emitted markup of `IssueQuickViewPanel` in proposal mode, at
motir-core `65a97b655`, captured through `tests/helpers/renderWithIntl` → `container.innerHTML` (en, and
zh where the panel says so), one capture per state. The delta is applied to those captures and to
nothing else. What the render showed:

- **The bar has ONE trip slot today, and while generating it holds only the pill.** The slot is
  `declined ?? elsewhereOffer` and, failing both, the arrivals / in-flight pill
  (`ProjectRoadmapCanvas.tsx`, `const offer` / `liveSlot`). The overlay passes `elsewhereOffer` only
  when `!live` (`PlanReviewCanvas.tsx`, `offerPlanElsewhere && !live`), so while a plan is written the
  elsewhere offer never arms.
- **The shipped pill already names the planner's level when the person has navigated away.** With the
  canvas on ACME-1 and the planner drafting under ACME-2, the bar reads _1 being drafted in ACME-2 · Go
  there_ (panel A4, top). That is exactly the trip **Follow the planner** offers, so the two would sit
  side by side saying the same thing. §28.2 decides it.
- **`locate-fixed` is taken.** It is the canvas's own _Locate the next of this plan's items_ control in
  the bottom cluster. The follow control therefore uses lucide `navigation`, the map convention for
  "follow me".
- **At the narrowest split (384px canvas) the shipped pill already crushes the crumbs** to a single
  letter, because it is `shrink-0` (panel A10, left). That is pre-existing and filed as bug
  MOTIR-8646 (§28.11, flag 3); the compact control below does not make it worse.
- **The follow move's transition is a literal, not a token:** `transition-opacity duration-[180ms]
motion-reduce:transition-none` on the level wrapper (`ProjectRoadmapCanvas.tsx`, the `PlanningCanvas`
  `className`), exactly as the follow-once design specified it (_a 180ms opacity crossfade_).

## 28.1 The rule, in one sentence

**On the planning overlay, while the plan is `generating`, the canvas FOLLOWS the planner: each new
driven step that names a level moves the canvas there, the person's first navigation turns following
OFF, and _Follow the planner_ turns it back ON.** Following starts ON when the overlay opens on a
generating plan. It is view state: it writes nothing, so a Visitor has it exactly as a member does.

## 28.2 The SUPERSESSION record — dated 2026-10-15

**What is replaced.** On the planning overlay, while the plan is `generating` only:

| shipped rule                                                                                                           | where it is recorded                                                                              | replaced by                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `followTo` is honoured **at most once per mount** (MOTIR-6161)                                                         | `design/ai-chat/design-notes.md` § _The canvas ARRIVES INSIDE…_ (MOTIR-6159), § _The FOLLOW-MOVE_ | each NEW driven key is honoured while following is ON                                |
| **never after the reader has navigated**; a declined request becomes _Plan is in {identifier} · Go there_ (MOTIR-6161) | the same section, § _The person who NAVIGATED FIRST_                                              | navigation turns following OFF; _Follow the planner_ asks again and turns it back ON |
| the canvas **never jumps** after the reader navigates (MOTIR-6300)                                                     | Part XXIII §23.7–23.8                                                                             | it still never jumps while following is OFF; it is driven only while following is ON |

**What is NOT dropped.**

- **Outside `generating`** (the conversation before a plan, a proposed plan, the plan page) the one-shot
  triggers keep their meaning: one move per mount, never after navigation, and the declined-follow offer
  with its words.
- **While generating, the arrivals count** (§23.7) keeps counting exactly as shipped, and the canvas
  never moves FOR an arrival. Only the driven step moves it.
- **The follow move itself**: its crossfade, its reduced-motion form and its announcement are reused
  for every driven move (§28.4).
- **MOTIR-6161 and MOTIR-6300 are `done` and are not edited.** They are the record of what was decided
  then. The three earlier records carry a one-line pointer to this Part.

## 28.3 Table A — the canvas pane's bar, per state

A "trip" is any control that moves the canvas to where the plan is. **The bar's right end becomes ONE
trips group** (`data-testid="canvas-bar-trips"`, `ml-auto flex shrink-0 items-center gap-1.5`): the
shipped pill (its own `ml-auto` dropped, since the group carries it), then the follow control, which
is always the rightmost so it never jumps when the pill comes and goes.

**The trip rule:** while generating, **the declined-follow offer is not armed** (Follow the planner is
that trip now), **the elsewhere offer stays unarmed** (shipped), and **the pill is HIDDEN whenever its
_Go there_ would land on the level _Follow the planner_ goes to**. Its count keeps counting underneath
and the pill returns as soon as the two destinations differ. So no row offers two controls to one place.

| state                                                                                           | the follow control (drawn form)                                                                                                                                                    | pill · _Go there_                                                                           | declined-follow offer   | elsewhere offer       | the canvas                                                            | panel |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------- | --------------------- | --------------------------------------------------------------------- | ----- |
| `generating`, ON, a driven step with a level                                                    | **the following status**: `navigation` glyph `--el-accent-on-surface` + _Following the planner_; no border, no fill, not a button                                                  | shows only for OTHER off-level steps; the driven card is on the canvas, so never this level | not armed               | not armed             | moves to the driven level on each new driven step                     | A1    |
| `generating`, ON, no driven level (settle, top-level lay, drafting-new, a node off the plan)    | the following status, unchanged                                                                                                                                                    | shipped                                                                                     | not armed               | not armed             | stays put                                                             | A2    |
| `generating`, ON, several steps in flight                                                       | the following status                                                                                                                                                               | counts the OTHER in-flight steps, shipped words                                             | not armed               | not armed             | holds the first step's level until it ends                            | A3    |
| `generating`, OFF (the person navigated)                                                        | **the _Follow the planner_ button**: the follow offer's markup with the `navigation` glyph in place of the dot                                                                     | HIDDEN when it lands on the driven level (the usual case), else shipped                     | not armed               | not armed             | stays where the person put it                                         | A4    |
| `generating`, OFF, already standing on the driven level                                         | **the button still shows**; pressing it moves nothing and only re-arms following                                                                                                   | shipped (it cannot name the level the person stands on)                                     | not armed               | not armed             | stays                                                                 | A5    |
| `stalled` (past `PLAN_STALLED_AFTER_MS`)                                                        | ON: the status; OFF: the button. **The glyph drops to `--el-text-faint`** (decorative, `aria-hidden`): armed, idle. No live step, so a press only re-arms                          | shipped (it may name the HELD card, which is not the button's trip)                         | not armed               | not armed             | nothing moves; keeps its place                                        | A6    |
| the poll `failing` (Reconnecting)                                                               | the same idle form as `stalled`                                                                                                                                                    | shipped                                                                                     | not armed               | not armed             | nothing moves; keeps its place                                        | A7    |
| the plan leaves `generating` (planned · approved · declined / discarded · failed · judged dead) | **GONE.** Leaving form: the shipped `canvas-fade-out` keyframe on `var(--transition-fast)` / `var(--canvas-ease-exit)`; under reduce, removed at the next paint                    | shipped non-generating behaviour                                                            | shipped meaning returns | arms again as shipped | never moves on its own again                                          | A8    |
| the List view active                                                                            | **not shown**: it lives in the canvas bar, which the List hides. There is nothing to press in List                                                                                 | —                                                                                           | —                       | —                     | the hidden canvas keeps following, silently; the List is never driven | A9    |
| the canvas pane narrower than `32rem` (the narrowest split is 384px)                            | **compact**: the glyph alone. The status keeps its label `sr-only`; the button is a `--height-control` square with `aria-label` and a native `title`. The label is never truncated | shipped                                                                                     | not armed               | not armed             | —                                                                     | A10   |
| a Visitor on a public project                                                                   | the same control; following is view state and writes nothing                                                                                                                       | shipped                                                                                     | not armed               | not armed             | as for anyone                                                         | A11   |
| `prefers-reduced-motion: reduce`                                                                | every row above, static: no leaving fade                                                                                                                                           | static                                                                                      | —                       | —                     | the move is instant                                                   | A12   |

**What counts as the person navigating** (turns following OFF): a crumb, Back, a drill into a card,
a search jump, the canvas level picker, and **the pill's own _Go there_**, because that is the person
choosing a level. A driven move, the hand-over at the end of generation and a pane swap are not.

**Why the ON state is a status and not a toggle.** A control that is always present would offer, while
following, only a way to switch the feature off, and moving the canvas already does that. So ON is
state, and only OFF is a button.

**Why the pill is hidden rather than muted.** Muting it would need the pill's words without _· Go
there_, which is a new string for words that belong to MOTIR-7820. Hiding changes no words, and the
moment the person presses _Follow the planner_ they stand on that level, which clears its arrivals
anyway (shipped `visitLevel`).

## 28.4 B — a driven level move

**It is the shipped follow move, unchanged:** the 180ms opacity crossfade on the LEVEL wrapper
(`transition-opacity duration-[180ms] motion-reduce:transition-none`, set and released by
`followFade`), the breadcrumb appending without animation, and the announcement. No new transition,
no slide, no zoom. The canvas remounts per level (`key={level:…}`), so arriving plays no card ENTRY
motion.

**The sequence (panels B1–B3):** (1) the old level, its drafted card breathing; (2) the crossfade, while
the new level's drafted card shows its **static** orange cue (wash, solid ring, rest scale); (3) at the
crossfade's `transitionend`, the card's cue takes up the shipped pop, then the breath.

**The move and the breath never animate the same element and never overlap.** The crossfade animates
the level wrapper's `opacity`; the pop and breath animate the node box's `scale` and the ring's
`box-shadow`. On a level entered by a driven move, the canvas withholds `data-cue-motion="at-work"`
until the crossfade's `transitionend`, so the pop starts when the crossfade has ended. Under reduced
motion there is neither, so there is nothing to gate.

**Two moves one poll apart (B4), judged at real size.** One move reads as calm. A pair 2.5s apart
(`POLL_MS`) is acceptable. A sustained run of steps that each end within one poll swaps the whole level
every poll, and the person never finishes reading a level: that reads as restless. **This is recorded
as flag 1 for MOTIR-8594**, and no dwell rule is invented here.

## 28.5 D — copy and the live region

| key                                            | `en`                          | `zh`               | where                                                        |
| ---------------------------------------------- | ----------------------------- | ------------------ | ------------------------------------------------------------ |
| `planningWorkspace.follow.following`           | `Following the planner`       | `正在跟随规划器`   | the ON status (and its `sr-only` label when compact)         |
| `planningWorkspace.follow.resume`              | `Follow the planner`          | `跟随规划器`       | the OFF button (and its `aria-label` / `title` when compact) |
| `planningWorkspace.follow.resumedAnnouncement` | `Following the planner again` | `已重新跟随规划器` | the live region, when a press moves nothing                  |

**Reused, not re-keyed:** `planningWorkspace.arrival.movedAnnouncement` (_Showing work inside
{target}_ / _正在显示 {target} 内的工作_) is the announcement for **a driven move** and for **a press
that moves the canvas**. No string is added for the typewriter. (`规划器` is the catalogue's existing
word for the planner, e.g. `detailsNoSteps`.)

## 28.6 C — fields type in, in the proposal quick view

> **SUPERSEDED 2026-11-13 by MOTIR-11190** — see §28.13 and Part XXIX (`peek-proposal-mode--being-written.mock.html`, MOTIR-11196).

Only in the peek opened from the overlay's canvas while the plan is `generating`. The plan page's peek
(`PlanDetail`) never types, and no peek opens by itself.

| case                                                                                   | what it shows                                                                                                                                                                                                                                     | panel |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| a field EMPTY / null / absent when the quick view opened, arriving on a later snapshot | **types in**                                                                                                                                                                                                                                      | C2–C4 |
| which fields type                                                                      | **title, description, explanation** type. **Type, Executor, Priority, Story points, Estimate, Difficulty appear** at once: each is a short token or a pill, and a pill spelled out letter by letter reads as a glitch, not as writing             | C2    |
| several fields arriving on one snapshot                                                | **one after another, in reading order: title → description → explanation.** The rail scalars on that snapshot appear immediately and do not wait. A field waiting its turn shows the shipped empty treatment                                      | C2–C3 |
| a long body                                                                            | **pace** `--typewriter-char-interval` per character; **cap** `calc(var(--transition-slow) * 3)` per field. A field longer than cap ÷ pace types faster, so it always lands within the cap. Three capped fields together stay inside one `POLL_MS` | C4    |
| the unwritten field before it arrives                                                  | the shipped empty treatment, cited and not redrawn: _No description yet._ / _No explanation yet._, `text-sm italic --el-text-secondary` (Part XIV)                                                                                                | C1    |
| a field that already had a value at open                                               | shows at once                                                                                                                                                                                                                                     | C5    |
| an already-shown value that changes                                                    | shows at once, never typed. A field typing or queued whose value changes is shown final at once                                                                                                                                                   | C5    |
| the quick view closed while typing, then reopened                                      | everything at once: what types is decided per OPEN, against the fields that were empty when that open began                                                                                                                                       | C5    |
| `prefers-reduced-motion: reduce`                                                       | the value simply appears                                                                                                                                                                                                                          | C5    |
| assistive tech                                                                         | hears the final value once, never per character (§28.7)                                                                                                                                                                                           | C6    |

**How a field types, so nothing reflows when it lands.** The typing copy is the field's own rendered
element (the `h2`, `TranslatableMarkdown`, `MarkdownView`) cloned with its text nodes cut at the
cursor, so a list item or a bold run appears as its text arrives inside its real block. A static 2px
caret (`w-0.5`, `h-[1em]`, `--el-accent-on-surface`, `aria-hidden`) sits at the cursor. It does not
blink: a blink is a loop. When the field lands, the copy and the caret are removed and the final
element is shown. The two have the same layout, so nothing moves.

**The ONE new token**, in `app/globals.css` `:root` beside `--canvas-ease-enter` / `--canvas-ease-exit`
(product-local; the peek is product-local):

| token                        | value  | why no existing token expresses it                                                                                                                                                                                                                                       |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--typewriter-char-interval` | `12ms` | the motion tokens are durations for a whole transition (`--transition-fast` / `-duration` / `-slow`); a per-character interval is an order of magnitude under the smallest of them. About 83 characters a second: faster than reading, slow enough to be seen as writing |

The cap reuses `--transition-slow`, so it follows a `[data-style]` that re-paces motion. No easing is
added (a typewriter is linear in characters).

## 28.7 Accessibility

> **The _a typed field_ row is SUPERSEDED 2026-11-13 by MOTIR-11190** — §28.13; its successor is Part XXIX §29.6. Every other row stands.

| element                         | disposition                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the following status            | plain text in the bar's `nav`; NOT a live region, because the bar is read on demand. Its glyph is `aria-hidden`; the faint idle glyph is decorative, which is the one use `--el-text-faint` is allowed                                                                                                                                      |
| the _Follow the planner_ button | a native `button` named by its label (or `aria-label` when compact). On press it becomes the status, so **focus moves to the canvas** (`role="application"`, already focusable): the place the person is now looking                                                                                                                        |
| a driven move                   | announced through the SHIPPED `canvas-follow-live` region (`role="status"`, polite), with `movedAnnouncement`, **once per LEVEL change**. A new step on the same level says nothing. No second `aria-live` region is added                                                                                                                  |
| a press                         | `movedAnnouncement` when it moves the canvas, else `resumedAnnouncement`, through the same region                                                                                                                                                                                                                                           |
| following turning OFF           | not announced: it is the person's own act                                                                                                                                                                                                                                                                                                   |
| the List view                   | the hidden canvas copy is `inert` + `aria-hidden` (shipped), so its moves announce nothing                                                                                                                                                                                                                                                  |
| a typed field                   | the typing copy is `aria-hidden`. The shipped final element is in the tree from the moment the field ARRIVES, `sr-only` while the copy types, and it is the SAME node when it lands, so a screen reader never meets a partial value and nothing is re-announced. No `aria-live` is added: the peek is a dialog the person reads, not a feed |
| contrast                        | the status and button label are `--el-text-secondary` (≥ 6.18:1 on every surface); the glyph is `--el-accent-on-surface` (a graphic, 3:1); the caret is a graphic                                                                                                                                                                           |

## 28.8 Token and shape roles

> **The _typing caret_ and _typewriter_ rows are SUPERSEDED 2026-11-13 by MOTIR-11190** — §28.13 (the caret lives on as Part XXIX's in-progress cue). Every other row stands.

| element            | colour                                                                                                                   | shape                                                                          | motion                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| trips group        | —                                                                                                                        | `gap-1.5` (layout)                                                             | —                                                                          |
| following status   | label `--el-text-secondary`; glyph `--el-accent-on-surface` (idle: `--el-text-faint`)                                    | `--spacing-control-x/y`                                                        | leaves on `canvas-fade-out`, `--transition-fast`, `--canvas-ease-exit`     |
| Follow the planner | `--el-card` on `--el-border`; label `--el-text-secondary`, hover `--el-text`; glyph as above; focus `--focus-ring-color` | `--radius-control`, `--spacing-control-x/y`; compact `size-(--height-control)` | the same leave                                                             |
| the driven move    | —                                                                                                                        | —                                                                              | the shipped follow crossfade, unchanged                                    |
| the typing caret   | `--el-accent-on-surface`                                                                                                 | `w-0.5` · `h-[1em]`                                                            | none (static)                                                              |
| the typewriter     | —                                                                                                                        | —                                                                              | `--typewriter-char-interval`, capped at `calc(var(--transition-slow) * 3)` |

No raw colour, no new easing and no new dependency in either `package.json`.

## 28.9 How the asset was produced

A temporary vitest harness rendered the shipped components in happy-dom with stubbed roadmap reads
(`ACME-1 Account access` › `ACME-2 Sign-in page` / `ACME-3 Password reset`, four proposals, author steps
on `ACME-2` and `ACME-3`), applied the delta to the captured DOM (the trips group, the follow control
built with lucide `Navigation`, the hidden pill, the typing copies), and wrote one capture per state. A
temporary script handed the captures to `renderMock` with the shipped canvas rules copied verbatim from
`app/globals.css` and the delta's rules. Board-only liberties, labelled in the stylesheet: the canvas
world is offset and scaled to 0.85, mid-motion frames are sampled statically (the crossfade at 40%, the
leaving fade at 50%), and `.board-reduced` stands for the media query. Every panel was screenshotted in
Chromium and looked at in light and dark. Both temporary files were deleted; the design lane
(`vitest --config vitest.design.config.ts`) is green over the asset.

## 28.10 GIVES / TAKES

> **The MOTIR-8595 row and MOTIR-8597's `data-typewriter` testid are SUPERSEDED 2026-11-13 by MOTIR-11190** — §28.13. Every other row stands.

- **MOTIR-8592** (the driven-step derivation) — **TAKES** what it must produce: the driven step and
  its level, ordered as the snapshot's steps, holding the first step's level until that step ends, and
  null for a step with no level. This Part draws the outcome only.
- **MOTIR-8593** (the canvas) — **TAKES** the move's transition unchanged; honouring each NEW follow key
  while following is ON; reporting the person's navigation (crumb, Back, drill, search jump, level pick,
  the pill's _Go there_) apart from its own moves; withholding `data-cue-motion` until the crossfade's
  `transitionend` on a driven arrival; announcing per level change only; and the one-shot meaning
  outside `generating`.
- **MOTIR-8594** (the host) — **TAKES** Table A verbatim: following ON at open on a generating plan, the
  trips group, the status and the button with their idle and compact forms, the trip rule (declined
  offer not armed while generating; the pill hidden when its trip equals the follow trip), focus to the
  canvas on press, the leaving form, the copy and live-region text of §28.5, and flag 1.
- **MOTIR-8595** (the typewriter) — **TAKES** Table C verbatim: which fields type, the order, the pace
  token and the cap, the clone-and-cut rendering, the caret, the per-open memory, and the AT mechanism
  of §28.7.
- **MOTIR-8596** (the coverage gate) — **TAKES** the surface: `ProjectRoadmapCanvas`,
  `PlanReviewCanvas`, `PlanProposalViews`, `PlanningWorkspaceHost`, `ProposalPeek` /
  `IssueQuickViewPanel`, the new derivation, the token in `app/globals.css`, and the three message keys.
- **MOTIR-8597** (the E2E) — **TAKES** the `data-testid`s (`canvas-bar-trips`, `canvas-follow-state`
  with `data-follow`, `canvas-follow-planner`, `data-typewriter="typing" | "waiting" | "final"`,
  `canvas-follow-live`) and the click path: open a generating plan, watch a driven move, drill away,
  press _Follow the planner_, open a proposal and watch a field type in.
- **MOTIR-8413 / MOTIR-8414** (Motir at work) — **TAKE nothing.** The cue's colour, pop, breath and
  leaving form are reused as they ship. The only touch is MOTIR-8593 delaying the pop on a level entered
  by a driven move, which changes when it starts and not what it is.
- **MOTIR-6161** (follow-once) — **TAKES · SUPERSEDED in part**, §28.2. Stays `done`.
- **MOTIR-6300** (never-jump) — **TAKES · SUPERSEDED in part**, §28.2. Stays `done`.
- **MOTIR-7820** (progress and cues) — its pill words are kept. This Part only decides when the pill
  hides.

## 28.11 Planning flags

1. **Sustained driven moves read as restless (B4) → MOTIR-8594.** When steps end within one poll
   several times in a row, the canvas swaps level every `POLL_MS`. A dwell or batching rule is the
   host's to propose; none is drawn here.
2. **The follow crossfade is a literal (`duration-[180ms]`), not a theme token.** It is reused
   unchanged, as the card requires; it does not flip with `[data-style]`. Tokenising it would change
   shipped motion, so it is left as found.
3. **At the narrowest split the shipped pill crushes the crumbs** (A10, `shrink-0` on the pill), before
   this delta adds anything. Filed as bug MOTIR-8646; this Part's compact form does not depend
   on it.
4. **The canvas must know the follow destination to hide the pill.** Today the slot is computed inside
   `ProjectRoadmapCanvas`, so MOTIR-8593 / MOTIR-8594 pass the driven level in beside `followTo`.

## 28.12 What Part XXVIII does NOT draw or decide

- Which step is driven and how its level is computed (MOTIR-8592); how the canvas honours a key
  (MOTIR-8593); the poll.
- The cue's colour, pop, breath and leaving form (MOTIR-8413), and the arrivals / in-flight words
  (MOTIR-7820).
- The plan page (`PlanDetail`): never driven, never typing. The List view's own content. An
  auto-opened quick view. A typewriter anywhere but the overlay's proposal quick view.
- A dwell rule between driven moves (flag 1).

## 28.13 The SUPERSESSION record for Table C — dated 2026-11-13 (Story MOTIR-11190 · design MOTIR-11196)

**What is replaced.** The proposal quick view no longer REPLAYS a field that already arrived; it
shows the model's partial text while the `author` session writes the card, and the stored card when
the write lands. The design is **Part XXIX**, the delta
[`peek-proposal-mode--being-written.mock.html`](./peek-proposal-mode--being-written.mock.html)
(MOTIR-11196). Superseded by **MOTIR-11190**:

| row                                                                                                                           | where  | successor                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| Table C — every row (which fields type, the order, the pace, the cap, the per-open memory, the long body, reduced motion, AT) | §28.6  | Part XXIX §29.1–§29.5, §29.7                                                              |
| the token `--typewriter-char-interval` (`12ms`)                                                                               | §28.6  | none: the text is driven by arriving data, not a pace (§29.9) — retired                   |
| _a typed field_                                                                                                               | §28.7  | §29.6, the final-value announcement                                                       |
| _the typing caret_                                                                                                            | §28.8  | the same caret, reused by the in-progress cue (§29.3–§29.4)                               |
| _the typewriter_                                                                                                              | §28.8  | none — retired                                                                            |
| MOTIR-8595 **TAKES** Table C                                                                                                  | §28.10 | MOTIR-11201 TAKES Part XXIX (§29.11)                                                      |
| the `data-typewriter="typing" \| "waiting" \| "final"` testid in MOTIR-8597's row                                             | §28.10 | `quick-view-live-cue` (`data-live-cue`) and `quick-view-live-<field>` (`data-live-field`) |

**What stands unchanged.** Following the planner on the canvas (§28.1–§28.2), Table A (§28.3), the
driven move B (§28.4), §28.5's copy and live region, every other row of §28.7, §28.8 and §28.10, the
flags (§28.11) and §28.12. **MOTIR-8591 and MOTIR-8595 are `done` and are not edited**; this record
and the one-line pointers under §28.6, §28.7, §28.8 and §28.10 are the whole change to Part XXVIII.

## ⭐ The guide-seeded Plans row (MOTIR-8686, 2026-10-15)

**Story MOTIR-8684. A DELTA** on `plans-sessions--seeded.mock.html` panel 1 and on `ai-chat/planning-workspace--pick-seed.mock.html` sheet 3 (the pick row). The mock is **`design/ai-planning/plans-sessions--guide-seeded.mock.html`**; it holds the new row beside the two shipped ones and edits neither.

A planning session started by **Confirm** on the guide's re-plan offer (the decision MOTIR-8685 (published as a Motir page; it amends A3.9 (b) of `docs/decisions/guide-turn-files.md`), its table _The target-wrong verdict, in full after this decision_) is a real session and is reachable from Plans like the refusal- and pick-seeded kinds. Its row is the shipped session row, markup unchanged. What differs is the seed link: **From the guide on {KEY}**, opening the **guided** card (the manual work item the person was walking through), not the row's anchor. The row title is the session's anchor (the target the re-plan was aimed at, resolved forward when needed). The row itself reopens the session; the first turn is withheld from the list and the session is hidden from a Visitor exactly as a gate seed's. A long title truncates as the pick row's label does; the full name is on the link's accessible name (_Open ACME-31, the work item Motir AI was guiding you through when it offered this re-plan_).

| Element         | Primitive            | Colour                                                    | Shape                                                       |
| --------------- | -------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Row             | session row          | `--el-surface`, `--el-border`, hover `--el-border-strong` | `--radius-card`, `--spacing-control-x/y`, `--shadow-subtle` |
| Seed link       | underlined text link | `--el-text-secondary`, underline `--el-border-strong`     | `--radius-control`                                          |
| Plan state chip | `Pill`               | `--el-chip-bg`, `--el-text-secondary`                     | `--radius-badge`                                            |

### Copy

| Key                | en                      | zh                  | Owner               |
| ------------------ | ----------------------- | ------------------- | ------------------- |
| `plans.seed.guide` | From the guide on {KEY} | 来自对 {KEY} 的引导 | session memory card |

Owned by the session memory card ([MOTIR-8697](motir:cmv9rgb6z0018hvoimygo28if) for the row; [MOTIR-8691](motir:cmv9rgayp000whvoiaxsj1gr3) for the data it reads).

## ⭐ The Plans list shows only conversations that reached planning (MOTIR-9298, 2026-10-22)

**Design system, checked first.** `package.json` depends on `@motir/design-system`
(`workspace:*`, installed 0.17.0) and `app/globals.css` imports
`@motir/design-system/theme.css`, so motir-core is ON Motir Design. The project's own axes come
from `app/layout.tsx` (`data-style` / `data-palette` / `data-type` from the applied theme); the
asset is drawn at the defaults the lifted sheet carries. Every part used ships today —
`Segmented`, `EmptyState` (both from the package), `PlanWithAILauncher` (product-local) and the
session row (product-local, reproduced) — so nothing is proposed as an addition.

**Story MOTIR-9217; decision MOTIR-9215, amendment 5 clause 6. A DELTA** on
[MOTIR-6019](motir:cmud0ajoc009ihwtxdqihxm75)'s published `plans-sessions--list.mock.html` (the
spec this file cites by title, _"The Plans page lists CONVERSATIONS"_, because the index gives
Part XIX to MOTIR-6053; that published asset is not on disk). The mock is
**`design/ai-planning/plans-sessions--reached-planning.mock.html`**. It draws only the two pieces
of chrome that change and edits no other asset. The stylesheet is lifted verbatim from
`plans-sessions--seeded.mock.html`; the strip, the empty states and the launcher are the shipped
components' markup emitted through `renderWithIntl`; the two rows in panel 1 are reproduced
unchanged from `plans-sessions--seeded.mock.html` only to place the strip.

### What changed underneath, and why the chrome follows

The list, its counts and the `?session=` landing admit only a conversation holding at least one
`plan` row, of any status (MOTIR-9300). No listed row can be in the no-plan state, so:

- **`total === 0` now means nothing in this view has reached planning.** It used to mean the
  project held no conversation at all (`_view.tsx`: _"a fact about the COUNTS — no conversation at
  all"_). The project may hold a conversation that asked a question and was answered; it is
  deliberately not listed, and the empty state does not mention it.
- **The strip's no-plan segment filters for nothing that can be shown,** so it retires from the
  drawn option set.

### The strip — eight segments

All, then `generating`, `waiting`, `planned`, `stale`, `approved`, `declined`, `closed`, in the
order `PLAN_SESSION_STATE_VALUES` gives them with `none` left out. No panel draws a `none`
segment or a `none` row chip. Everything else is the shipped strip: counts in the `trailing` slot
(`hidden sm:inline`), the `overflow-x-auto whitespace-nowrap` scroller, the selected segment
scrolled into view on mount, a segment whose count is 0 still drawn, the shipped hover and
focus-visible treatment, no disabled or pending state. In every panel the seven state counts sum
to the All count.

**A `?planState=none` address draws the All panel (panel 1)** and owes no state of its own: the
parser serves a value the vocabulary does not hold as All (and until the parser narrows, the
service does — MOTIR-9300). Whether `none` leaves `PLAN_SESSION_STATE_VALUES` itself is the
reads' and the strings' work, not this asset's.

| Element              | Primitive                         | Colour                                                                                           | Shape                                                           |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Strip track          | `Segmented` group                 | `--el-tabnav-track`, `--el-border`                                                               | `--radius-btn`                                                  |
| Selected segment     | `Segmented` button                | `--el-page-bg`, `--el-text-strong`, count `--el-tabnav-active`, `--shadow-subtle`                | `--height-control`, `--spacing-control-x`, `--radius-btn` − 2px |
| Other segment        | `Segmented` button                | `--el-text-secondary`, hover `--el-text`, count `--el-text-secondary`                            | as above                                                        |
| Project / Mine empty | `EmptyState` + Sparkles icon      | `--el-card`, `--el-border`, icon `--el-icon-muted`, title `--el-text`, body `--el-text-subtitle` | `--radius-card`, `--spacing-card-padding`                       |
| Fresh-start launcher | `PlanWithAILauncher` (pill)       | accent hero fill, `--el-accent-text`                                                             | `--radius-badge`, `--height-btn-md`, `--spacing-btn-x`          |
| Filtered empty       | `EmptyState` (shipped, unchanged) | as shipped                                                                                       | as shipped                                                      |

### The settled words (en; the zh twin ships with the strip-and-strings card, MOTIR-9301)

| Key                                                                 | en                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `aiPlanning.sessions.emptyTitle` (Project)                          | Nothing has reached planning yet                                |
| `aiPlanning.sessions.emptyDescription` (Project, can author)        | A conversation appears here once it reaches planning.           |
| `aiPlanning.sessions.emptyDescriptionRead` (Project, cannot author) | A conversation appears here once it reaches planning.           |
| `aiPlanning.sessions.emptyMineTitle` (Mine)                         | No conversation of yours has reached planning yet               |
| `aiPlanning.sessions.emptyMineDescription` (Mine)                   | A conversation you start appears here once it reaches planning. |

No project-level variant says the project holds no conversations, or that the reader has not
talked to the assistant. "Of yours" rather than "you started", because the Mine read also covers
plans the reader decided or was routed. The filtered-empty keys are untouched; that state is
reproduced unchanged in panel 5 so the two emptinesses still read differently (Part VII §6): only
the project-level one offers a fresh start, and only the filtered one keeps the strip.

### Panels

1. The strip, wide, All selected, over two reproduced rows (counts illustrative, summing to 18).
2. The strip, narrow (375px), counts hidden, Approved selected and scrolled into view.
3. Project-empty, a reader who can author: no strip, the title and sentence, the launcher.
4. Project-empty, Mine view with the launcher; and the Project view for a reader who cannot
   author, with no action.
5. Filtered-empty, unchanged: strip present (Stale selected, count 0), shipped copy, no CTA.

### Supersedes

**The sessions spec's reason for All-as-default is retired; the default is not.** Two files carry
the same sentence, `lib/planning/planSessionFilter.ts` and
`app/(authed)/plans/_components/PlanStatusTabs.tsx`:

> the story's first promise is that a conversation that never proposed anything is findable, and
> the only default that shows it without a click is All.

Such a conversation is no longer listed, so that reason is false from now on. All stays the
default for the reason that survives: a clean URL, and a list that opens on everything it can
show. The strip-and-strings card (MOTIR-9301) corrects both comments when it drops the segment.

### What this delta does NOT draw or decide

The reads (MOTIR-9300), the gate and the lease (MOTIR-9299), the fresh-start notice's pointer
(MOTIR-9304), the strings and the parser (MOTIR-9301), the coverage and the receipt (MOTIR-9302,
MOTIR-9303); the rows, the Mine/Project switch, the read-failed state, the paging sentinel, the
`?session=` highlight and the overlay — all shipped and unchanged. No PNG is exported: a new asset
is a mock alone (`docs/decisions/design-result.md` AMENDMENT 4).

# Part XXIX — the proposal quick view of a card BEING WRITTEN: live fields, the in-progress cue, the stored hand-over and the refused write (MOTIR-11196 · Story MOTIR-11190 — `peek-proposal-mode--being-written.mock.html`, DATED 2026-11-13)

**Design system, identified first.** Read `package.json` (line 145, `"@motir/design-system":
"workspace:*"`) and `app/globals.css` (line 13, `@import '@motir/design-system/theme.css'`). Both
hold, so the verdict is **(a) ON MOTIR DESIGN**, package **v0.22.4**
(`packages/design-system/package.json`). The axes are per person (`app/layout.tsx` stamps the
reader's `data-style` / `data-palette` / `data-type`; a signed-out Visitor gets none), so the board
renders at the package defaults (`warm-editorial` · `motir` · `motir`). The package exports
`@motir/design-system/mock`, and the board is built with its `renderMock` at `boardWidth: 'full'`.
Every part on this surface is product-local, so the board composes those parts' **real emitted
markup**:

| part                                                              | kind                    | reason                                                                           |
| ----------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `IssueQuickViewPanel` in proposal mode (opened by `ProposalPeek`) | product-local component | the Part XIV peek, cited and not redrawn                                         |
| `PlanItemNode` (P0, the access path)                              | product-local component | the overlay canvas card that opens the peek; its drafting cue is Part XXVI §26.6 |
| the **in-progress cue** (`quick-view-live-cue`)                   | product-local component | NEW, one line in the peek's header; nothing to add to the package                |
| the **live field** wrapper (`quick-view-live-<field>`)            | product-local component | NEW, a wrapper around the peek's own field elements                              |

Nothing is proposed for `@motir/design-system`. **No token is added**, and one is retired (§29.9).

**The number.** _Part XXIX_ is free. Checked on 2026-11-13 against this file's index (Part XXVIII,
MOTIR-8591, is the last Part row) and its headings (`grep -n "^# Part" design-notes.md`: XXVIII is the
last), and against the area's published results (`list_designs { projectKey: "MOTIR", pathPrefix:
"design/ai-planning/" }`: the newest is MOTIR-9298's delta, which took no Part number, and nothing is
published past XXVIII).

**A DELTA.** Base: `peek-proposal-mode.mock.html` (Part XIV, the proposal quick view) — not edited.
It SUPERSEDES Part XXVIII §28.6 Table C (the replay typewriter) and its dependent rows; the dated
record is **§28.13**. The rest of Part XXVIII (following the planner, Tables A and B, §28.5's copy)
stands unchanged.

**Asset:** [`peek-proposal-mode--being-written.mock.html`](./peek-proposal-mode--being-written.mock.html).

| Panel | State                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| P0    | The access path: the card being written on the overlay canvas opens the quick view                          |
| P1    | Writing, no partial yet — the cue shows, every field is a waiting field                                     |
| P2    | Writing, one field growing — the description, caret at its end                                              |
| P3    | Writing, several fields — title partial, description growing (inside an open bold run), explanation waiting |
| P4    | A long description growing past the fold — the reader's scroll position is kept                             |
| P5    | Opened mid-stream — the first frame already shows the partial, the next read grows it                       |
| P6    | The stored hand-over — last live frame beside the landed card                                               |
| P7    | The refused-write state — growing beside dropped                                                            |
| P8    | Closed and reopened during writing — the current partial at once                                            |
| P9    | The plan page's peek (`PlanDetail`) and any peek outside `generating` — shipped, no live field              |
| P10   | A Visitor on a public project — the same live view, read-only                                               |
| P11   | `prefers-reduced-motion: reduce`                                                                            |
| P12   | Dark: growing (P3) and landed (P6)                                                                          |
| P13   | Narrow split (480px): the cue wraps under the per-op header; en and zh                                      |
| P14   | The final-value announcement: what a screen reader meets at each moment                                     |

> **P4 is SUPERSEDED in part 2026-11-14 by MOTIR-11249** — it now draws the DEFAULT, not-following state only; following the caret is Part XXX (`peek-proposal-mode--follow-the-writing.mock.html`).

## 29.0 Rendered before drawn

Every peek on the board is the emitted markup of `ProposalPeek` → `IssueQuickViewPanel` in proposal
mode at motir-core `2ad6b104` (main) plus the MOTIR-11199 commit on the story branch, captured in
happy-dom through `tests/helpers/renderWithIntl` (en; zh in P13), one capture per state, with the
dialog panel itself (`[data-surface="modal"]`) taken as the frame. The delta is applied to those
captures and to nothing else. What the render showed:

- **The header row is one line, `flex items-center`, with no wrap** (`QuickViewHeader`): type glyph,
  _New_ (or the key), the op chip, a `flex-1` spacer, then Close. There is room after the op chip on
  every width the overlay gives the peek except the narrowest, which is why the cue goes there and
  why the narrow form wraps (§29.4).
- **The three live-able fields are each ONE element in the main column**: the title `h2`
  (`font-serif text-[27px]`), the description (`TranslatableMarkdown`, `.motir-prose`) or its empty
  `p`, and the explanation (`MarkdownView`) or its empty `p`. A partial rendered through those same
  elements lays out exactly as the stored value will, so the hand-over moves nothing.
- **The rail's empty states are the shipped ones**: Type, Executor and Difficulty read _None_, Story
  points and Estimate are absent rows, and **Priority reads _Medium_** because `proposedPayload`
  defaults an unset priority to `medium` (that is the shipped empty treatment; this delta does not
  change it).
- **The shipped typewriter is dormant on this capture** (the peek opened with `live` off): no
  `data-typewriter` node, no `--typewriter-char-interval` read. Nothing of it is reused but its caret
  class.

## 29.1 The rule, in one sentence

**On the planning overlay, while the plan is `generating`, the quick view of a proposal that an
`author` session is writing shows that session's partial title, description and explanation as the
overlay's live plan read serves them, in the fields' own elements, with an in-progress cue; when the
completed write lands the stored proposal replaces them in place, and when the draft is dropped
without a write they vanish.** Nothing is replayed: the text on screen is the text the model has
written so far.

## 29.2 The elements, named

| element                      | what it is                                                                                                                                                                                                                                                                                                                                                                 | reads                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **live field**               | The title, description or explanation of a card being written, showing its PARTIAL text and growing as later reads arrive. Rendered **through the field's own element** (the `h2`, `TranslatableMarkdown`, `MarkdownView`), inside an `aria-hidden` copy, with the field's stored element (or its empty state) `sr-only` beside it. Only these three fields are ever live. | the partial `title` / `descriptionMd` / `explanationMd` of ONE proposal on the overlay's live plan read                                                           |
| **waiting field**            | A live-able field with no partial yet: the stored value if the proposal has one (the title it was laid with), else Part XIV's empty treatment (_No description yet._ / _No explanation yet._, cited).                                                                                                                                                                      | the stored proposal                                                                                                                                               |
| **in-progress cue**          | (1) A quiet status line in the header, right after the op chip: `pen-line` + _Being written_. (2) The shipped static caret at the end of the live field that grew most recently. **One caret at a time.** Shown whenever the session is writing the card, even before any partial arrives (P1).                                                                            | that this proposal is being written: the live read's current `author` step targets it (the same signal as Part XXVI's drafting cue), or a draft for it is present |
| **stored hand-over**         | The completed write landed: the stored proposal replaces each live field in place, in the same element, with no reflow. The cue line and the caret leave; the rail scalars take their stored values at the same moment.                                                                                                                                                    | the stored proposal, on the read that carries no draft and a changed proposal                                                                                     |
| **refused-write state**      | The draft is cleared without a stored write (refused, the step ended, the plan stopped generating). The partial text is dropped; every field returns to its stored value or empty treatment; the cue leaves. Nothing reads as saved and no partial stays on screen.                                                                                                        | the stored proposal, on the read that carries no draft and an UNCHANGED proposal                                                                                  |
| **final-value announcement** | The accessibility rule (§29.6): a screen reader meets only the field's stored value (or empty state); the cue's line is the one polite `role="status"`, saying _Being written_ once and _Written_ once.                                                                                                                                                                    | the cue's state                                                                                                                                                   |

**The data, by the card that defines it.** The partial fields come from the plan-step door card
(MOTIR-11199) and ride the live plan read as `inFlightDrafts[]` (`planItemId`, `title`,
`descriptionMd`, `explanationMd`, each a string or null, newest per proposal); its field names
govern. This Part draws the draft's STATES — absent, present and growing, landed, dropped — never its
shape. A field that is `null` in the draft is a waiting field; a non-null one is a live field.

**Hand-over versus refusal, as the reader sees them.** Both are a read on which the draft is gone.
If the stored proposal changed on that read, it is the hand-over (_Written_ is announced); if it did
not, it is the refusal (nothing is announced). The peek decides nothing else: the text simply becomes
whatever the stored proposal holds.

## 29.3 How a live field renders — no reflow at the hand-over

```
<div class="min-w-0" data-testid="quick-view-live-<field>" data-live-field="growing|partial">
  <div aria-hidden="true" data-live-partial>  …the field's own element, rendering the PARTIAL…  <caret/></div>
  <div class="sr-only">                       …the field's own element, rendering the STORED value or empty state…</div>
</div>
```

- `data-live-field="growing"` is the field holding the caret; the other live fields are `"partial"`.
- **The caret** is the shipped one, reused: `inline-block h-[1em] w-0.5 align-text-bottom
bg-(--el-accent-on-surface)`, `aria-hidden`, static (no blink: a blink is a loop), placed after the
  last character of the partial inside its real block (a paragraph, a list item).
- **Which field holds it**: the field whose partial changed on the latest read. If several changed on
  one read, the last of them in reading order (title → description → explanation), because the model
  writes in that order.
- **Partial markdown that is unterminated renders as plain text up to the cut, never as broken
  markup.** Every block already closed renders as markdown; a list item that has begun renders in its
  list; an inline run still open (`**`, a backtick, a link's `[`) shows its text as plain text with
  its opening marker WITHHELD until the run closes (P3: _…revoked by Sign out_ with no `**`). Never a
  literal `**`, never a half link, never a `- ` with nothing after it.
- **When the write lands** the wrapper is replaced by the field's element rendering the stored value
  — the same element the partial used, so the same lines. The only geometry that changes is the
  header losing the cue line (it sits in the header row, so the row keeps its height) and the last
  characters arriving.

## 29.4 The in-progress cue — placement and anatomy

| part                | spec                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| element             | `<p role="status" data-testid="quick-view-live-cue" data-live-cue="writing">`, the header's next child after the op chip (the per-op header of Part XIV §4)                                                                                                                |
| layout              | `inline-flex min-w-0 items-center gap-1.5`                                                                                                                                                                                                                                 |
| glyph               | lucide `pen-line` — the authoring act's glyph (the act record's `authoring`, the drafting chip of §26.6) — `size-3.5 shrink-0`, `--el-accent-on-surface`, `aria-hidden`                                                                                                    |
| label               | _Being written_, `text-xs font-medium`, `--el-text-secondary`                                                                                                                                                                                                              |
| narrow (P13)        | when the header cannot hold it on one row, it **wraps under** the per-op header onto its own line (`order-last basis-full`, header `flex-wrap gap-y-1.5`), driven by a container query on the peek so it follows the peek's width, not the viewport's. It never truncates. |
| after the hand-over | the visible line leaves; the element stays mounted as `sr-only` text _Written_ (`data-live-cue="written"`)                                                                                                                                                                 |
| after a refusal     | the visible line leaves; the element stays mounted and EMPTY (`data-live-cue="idle"`), so nothing is announced                                                                                                                                                             |
| motion              | none: it appears and leaves with the read that carries the change, in both motion modes                                                                                                                                                                                    |

The status element is mounted for as long as the quick view is open on a generating plan, so its two
changes are real changes to a live region and are announced.

## 29.5 Where the reader's eye stays

> **The first paragraph is SUPERSEDED 2026-11-14 by MOTIR-11249** — Part XXX (`peek-proposal-mode--follow-the-writing.mock.html`). The peek still never scrolls for the reader BY DEFAULT, but it now offers _Follow the writing_: pressed, it keeps the caret in view in whichever field holds it, and the reader's own scroll turns it off. The never-scroll rule below holds only while following is off. The second paragraph (_Where it shows_) stands.

A growing description never scrolls the peek for the reader. `QuickViewMain` is its own scroller;
its `scrollTop` is kept across reads (P4). Text appended below the viewport never moves what the
reader sees, and the caret is allowed to be out of view; text that grows above the reader (a title
wrapping to a second line) is absorbed by native scroll anchoring (`overflow-anchor: auto`, the
browser default — nothing may turn it off on this column). It is the same principle as the canvas
never jumping after the reader navigates (Part XXIII).

**Where it shows.** Only in the peek opened from the overlay's canvas (or list) while the plan is
`generating`. The plan page's peek (`PlanDetail`) never shows partial text (P9), as today. A Visitor
on a public project sees the same live view; proposal mode already suppresses every editor (Part XIV
§5), so it is read-only by construction (P10). Opening or reopening mid-stream shows the partial so
far at once (P5, P8): the draft is data, not a replay, so nothing is remembered per open.

## 29.6 Accessibility — the final-value announcement

| element              | disposition                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a live field         | its partial copy is `aria-hidden`; the tree holds the field's STORED element (or its empty state), `sr-only`. A screen reader never meets a partial value and no value is ever announced                                                  |
| the in-progress cue  | the ONE live element: `role="status"` (polite). It says _Being written_ once, when writing starts, and _Written_ once, when the stored card lands. It announces the state, never a value. On a refused write it says nothing (it empties) |
| opened mid-stream    | the cue's text is already in the tree when the peek opens, so it is read in order with the header, not announced                                                                                                                          |
| the caret, the glyph | decorative, `aria-hidden`; graphics (3:1): `--el-accent-on-surface`                                                                                                                                                                       |
| contrast             | the cue label is `--el-text-secondary` (≥ 6.18:1 on every surface, both themes)                                                                                                                                                           |
| the dialog           | unchanged: still the Part XIV dialog the person reads; no `aria-busy`, which would hide the stored values from some readers for the whole stream                                                                                          |

## 29.7 Reduced motion

Nothing in this delta animates. Under `prefers-reduced-motion: reduce` the text still updates as reads
arrive (it is data, not motion), and the cue arrives and leaves without a transition — exactly as in
the default mode (P11).

## 29.8 Copy — `messages/en.json` and `messages/zh.json`

| key                                | `en`            | `zh`       | where                                                    |
| ---------------------------------- | --------------- | ---------- | -------------------------------------------------------- |
| `planReview.peekLive.beingWritten` | `Being written` | `正在撰写` | the cue's visible label and its first announcement       |
| `planReview.peekLive.written`      | `Written`       | `已写入`   | the cue's `sr-only` text after the hand-over (announced) |

`planReview` is the namespace the peek already reads in proposal mode (`tPlan`: `newItem`,
`noExplanation`). No other string is added, and the typewriter added none to remove. The other nine
locales follow the catalogue's parity rule in the card that adds the keys.

## 29.9 Token and shape roles

| element    | colour                          | shape                                   | motion |
| ---------- | ------------------------------- | --------------------------------------- | ------ |
| cue line   | label `--el-text-secondary`     | `gap-1.5` (layout)                      | none   |
| cue glyph  | `--el-accent-on-surface`        | `size-3.5`                              | none   |
| the caret  | `--el-accent-on-surface`        | `w-0.5` · `h-[1em]` (the shipped caret) | none   |
| live field | the field's own inks, unchanged | the field's own element, unchanged      | none   |

**No token is added.** The replacement is driven by arriving data, not by a pace, so the typewriter's
`--typewriter-char-interval` has no successor; it is retired with the typewriter (§28.13). No raw
colour, no new easing and no new dependency.

## 29.10 How the asset was produced

A temporary vitest file rendered `ProposalPeek` in happy-dom with a fixture proposal (`Remember me on
this device`, an `add` under `ACME-2 Sign-in page`), once with the stored values and once with each
state's partial values, took the dialog panel of each capture, and applied the delta to the stored
capture: the live-field wrappers (the partial capture's field element inside an `aria-hidden` copy,
the stored element `sr-only` beside it, the caret after the last character) and the cue line. A
temporary script handed the captures to `renderMock`, with the shipped `.motir-prose` rules of
`components/ui/markdown-editor.css` copied into the board's style (labelled there) because
`theme.css` does not carry them. Board-only liberties: the dialog is drawn static at a fixed size
instead of `w-[90vw]`, and P13 drops the `md:` two-column rail as the overlay's narrow viewport does.
Every panel was screenshotted in Chromium and looked at; P12 is the dark board. Both temporary files
were deleted; the design lane (`vitest --config vitest.design.config.ts`) is green over the asset.

## 29.11 GIVES / TAKES

- **MOTIR-11199** (the draft door, `inFlightDrafts` on the review read) — **GIVES** the data: the
  partial `title` / `descriptionMd` / `explanationMd` for one proposal, absent when there is none.
  This Part reads its states only.
- **MOTIR-11201** (the quick view) — **TAKES** everything above verbatim: the live field and its
  wrapper, the waiting field, the in-progress cue (placement, glyph, label, narrow wrap, its three
  `data-live-cue` states), the caret rule, the partial-markdown rule, the stored hand-over, the
  refused-write state, the scroll rule, the final-value announcement, the two message keys, and
  retiring the typewriter (`lib/planning/typeIn.ts`, `TypeInText`, `--typewriter-char-interval`,
  `data-typewriter`).
- **The story's E2E** — **TAKES** the `data-testid`s `quick-view-live-cue` (with `data-live-cue`) and
  `quick-view-live-<field>` (with `data-live-field`), in place of `data-typewriter`.
- **Part XIV** (the peek) and **Part XXVI §26.6** (the drafting cue on the canvas card) — **TAKE
  nothing.**

## 29.12 What Part XXIX does NOT draw or decide

How the partial text travels from motir-ai to motir-core, the live read's shape, and the planner's
streaming; deleting the typewriter's code, token and tests (the quick-view card's); the other nine
locales' strings; the plan page's peek (unchanged); the canvas card's drafting cue (unchanged).

# Part XXX — _Follow the writing_: a control in the proposal quick view of a card BEING WRITTEN that keeps the caret in view until the reader scrolls (MOTIR-11249 · fix MOTIR-11248 — `peek-proposal-mode--follow-the-writing.mock.html`, DATED 2026-11-14)

**Design system, identified first.** Read `package.json` (`"@motir/design-system": "workspace:*"`)
and `app/globals.css` (`@import '@motir/design-system/theme.css'`). Both hold, so the verdict is
**(a) ON MOTIR DESIGN**, package **v0.22.4** (`packages/design-system/package.json`). The axes are
per person (`app/layout.tsx` stamps the reader's `data-style` / `data-palette` / `data-type`), so the
board renders at the package defaults (`warm-editorial` · `motir` · `motir`). The package exports
`@motir/design-system/mock`, and the board is built with its `renderMock` at `boardWidth: 'full'`.

| part                                                              | kind                    | reason                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IssueQuickViewPanel` in proposal mode (opened by `ProposalPeek`) | product-local component | the Part XIV peek with Part XXIX's live fields and cue, shipped; cited and not redrawn                                                                  |
| `PlanItemNode` (F0, the access path)                              | product-local component | the overlay canvas card that opens the peek; its drafting cue is Part XXVI §26.6, shipped                                                               |
| the **follow toggle** (`quick-view-live-follow`)                  | product-local component | NEW. The shipped `FollowPlannerControl` off-button recipe plus `aria-pressed`; it belongs beside the overlay's other follow control, not in the package |
| the **live group** (`quick-view-live-group`)                      | product-local component | NEW, a wrapper that holds the shipped cue and the toggle so they wrap onto one line together at the narrow width                                        |
| `Tooltip`                                                         | `@motir/design-system`  | shipped, unchanged                                                                                                                                      |

Nothing is proposed for `@motir/design-system`. **No token is added.**

**The number.** _Part XXX_ is free. Checked on 2026-11-14 against this file's headings (`grep -n "^#
Part"`: XXIX is the last) and against the area's published results (`list_designs { projectKey:
"MOTIR", pathPrefix: "design/ai-planning/" }`: the newest is MOTIR-11196's Part XXIX).

**A DELTA.** Base: `peek-proposal-mode--being-written.mock.html` (Part XXIX) — not edited. It
SUPERSEDES the first paragraph of **§29.5** (_A growing description never scrolls the peek for the
reader_) and narrows case **P4** to the default state; both carry a dated pointer here. Everything else
in Part XXIX stands: the live field, the waiting field, the cue, the caret rule, the hand-over, the
refused write, the announcement, the copy.

**Asset:** [`peek-proposal-mode--follow-the-writing.mock.html`](./peek-proposal-mode--follow-the-writing.mock.html).

| Panel | State                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| F0    | The access path: the card being written on the overlay canvas opens the quick view, which offers the control at once         |
| F1    | Writing, NOT following — the default on every open: the control is offered, the view does not move (light/dark, 928/480, zh) |
| F1b   | The tooltip and the focus ring, hover or keyboard focus (light en, light zh, dark pressed)                                   |
| F2    | FOLLOWING — pressed; the caret in the description is brought into view after every read (light/dark, 928/480, zh)            |
| F3    | FOLLOWING across fields — the explanation grew last, so the view follows the caret there, not to the column's bottom         |
| F4    | Following, then the reader scrolls — following turns off at once, the view stays where they put it, the control is offered   |
| F5    | Writing ends while following, the stored card lands (written): the control goes, the view does not jump                      |
| F6    | Writing ends while following, the draft goes with no write (idle): the control goes, nothing is announced                    |
| F7    | A card NOT being written — a stored proposal on the generating overlay, and the plan page's peek (P9): no control            |
| F8    | `prefers-reduced-motion: reduce` — every follow scroll is instant                                                            |
| F9    | How the reader's scroll is told from the follow's own scroll, and the keyboard                                               |

## 30.0 Rendered before drawn

Every peek on the board is the emitted markup of `ProposalPeek` → `IssueQuickViewPanel` at motir-core
`8ea1eedc8` (main, after MOTIR-11190 merged), captured in happy-dom through `tests/helpers/renderWithIntl`
(en; zh where a caption says so), one capture per state, each a sequence of reads (rerenders) so the
cue's state machine (`nextLiveCue`) reached the state drawn. The delta is applied to those captures and
nothing else. What the render showed:

- **The cue is ALREADY on its own wrapped line at the narrow width.** It carries
  `@max-[32rem]/peek:order-last @max-[32rem]/peek:basis-full` and the header is `flex-wrap gap-y-1.5`
  inside `@container/peek`. A control placed beside it must wrap WITH it, so both go into one group
  that takes those two classes (§30.3).
- **The cue `<p role="status">` must never be remounted.** It stays mounted (empty, or `sr-only`
  _Written_) after writing ends so its changes are announced (§29.4, §29.6). A wrapper that appeared
  and disappeared with the control would remount it and drop the _Written_ announcement. So the group
  is mounted for exactly as long as the cue is, and only its classes change (§30.3).
- **All three live fields are in ONE scroller.** The title `h2`, the description and the explanation
  all render inside `QuickViewMain` (`min-w-0 overflow-y-auto px-7 pt-6 pb-7`); the rail is a
  separate scroller. So following moves exactly one element's `scrollTop`.
- **The overlay already ships a follow control:** `FollowPlannerControl` (Part XXVIII §28.3) on the
  canvas bar — lucide `navigation`, _Follow the planner_, `--radius-control` /
  `--spacing-control-x/y` on `--el-card` with `--el-border`. **`locate-fixed` is taken** by the
  canvas's own _Locate_ control. This toggle reuses that recipe and glyph, so the overlay has one
  follow vocabulary.
- **The header row's height is set by Close** (`--height-control`). The toggle is
  `py-(--spacing-control-y)` + `text-xs`, shorter than Close, so on the normal width the row does not
  grow when it appears or leaves.

## 30.1 The rule, in one sentence

**While a card is being written, the quick view offers _Follow the writing_ beside the in-progress
cue; it starts OFF on every open, pressing it brings the caret into view and keeps it there after every
read in whichever field holds it, the reader's own scroll turns it OFF at once (keeping their
position), pressing again turns it back ON, and when writing ends the control goes with the cue's
visible line and the view does not move.**

## 30.2 The states

| state                                                   | control                                                                                             | the main column                                                                                                                                                     | panel |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| writing, not following (default; every open and reopen) | offered: `aria-pressed="false"`                                                                     | never moves for the reader: §29.5's rule, unchanged in this state. The caret may be out of view                                                                     | F1    |
| following                                               | pressed: `aria-pressed="true"`                                                                      | after the press and after every read, the caret is brought into view (§30.4), in whichever field holds it (`grewLast`) — title, description or explanation          | F2 F3 |
| following, then the reader scrolls                      | back to offered, in the same frame as the input                                                     | stays where the reader put it; text keeps growing out of view, as in the default state                                                                              | F4    |
| writing ends while following — stored card lands        | removed, with the cue's visible line (the cue stays `sr-only` _Written_)                            | `scrollTop` is kept: no scroll to the top, no scroll to the end. The stored text replaces the partial in the same elements (§29.3), so nothing reflows              | F5    |
| writing ends while following — draft goes with no write | removed, with the cue's visible line (the cue stays mounted and empty)                              | `scrollTop` is kept; the fields return to their stored value or empty treatment (§29.2 P7), so a shorter column clamps it — the browser's clamp, not a scroll by us | F6    |
| a card not being written                                | absent: stored proposal on the overlay, any committed card, the plan page's peek (P9)               | shipped                                                                                                                                                             | F7    |
| narrow peek (P13, below `32rem`)                        | wraps WITH the cue onto its own header line, after it; full label, never icon-only, never truncated | as in the width-independent states above                                                                                                                            | F1–F7 |
| reduced motion                                          | unchanged                                                                                           | every follow scroll is instant                                                                                                                                      | F8    |
| a Visitor on a public project                           | the same control: following is view state and writes nothing                                        | as for anyone                                                                                                                                                       | (P10) |

**Per open, and per card.** Following lives in the open quick view only. Closing and reopening the
peek, or opening another card's peek, starts OFF. It is not stored, not shared and not remembered.

**Following with nothing to follow yet.** Pressed before any partial has arrived (P1), nothing moves
until the first read carries a partial; then the caret is brought into view as usual.

**A read that changes no field** (the caret keeps its field, §29.3) re-checks the caret's position and
moves nothing if it is still in view.

## 30.3 The control — placement and anatomy

```
<div data-testid="quick-view-live-group" class="inline-flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 @max-[32rem]/peek:order-last @max-[32rem]/peek:basis-full">
  <p role="status" data-testid="quick-view-live-cue" data-live-cue="writing" class="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-(--el-text-secondary)">…Being written</p>
  <Tooltip content="Keep the text being written in view. Scroll to stop.">
    <button type="button" data-testid="quick-view-live-follow" aria-pressed="false|true" class="…">
      <Navigation aria-hidden class="size-3.5 shrink-0 text-(--el-accent-on-surface)" /> <span>Follow the writing</span>
    </button>
  </Tooltip>
</div>
```

| part         | spec                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the group    | takes the cue's place in the header, right after the op chip. It carries the narrow wrap the cue used to carry (`order-last basis-full` under `@max-[32rem]/peek`); the cue loses those two classes. **Mounted for exactly as long as the cue is**; when the cue is not `writing` it holds only the cue and is `class="contents"`, so it adds no flex item, no gap and nothing to the layout, and the cue element is never remounted |
| the toggle   | the cue's next sibling inside the group. Rendered only while the cue is `writing`. A native `button` with `aria-pressed`                                                                                                                                                                                                                                                                                                             |
| resting      | `inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary) hover:text-(--el-text)` — `FollowPlannerControl`'s button, verbatim                                                                                                                                                            |
| pressed      | `aria-pressed:border-(--el-accent) aria-pressed:bg-(--el-tint-lavender) aria-pressed:text-(--el-accent-on-surface)` (and the same text on hover) — the overlay's shipped pressed treatment (the show-changes toggle, Part XIII §3e), styled from the attribute so the state has one source                                                                                                                                           |
| glyph        | lucide `navigation`, `size-3.5`, `--el-accent-on-surface`, `aria-hidden` — the overlay's follow glyph (§28 Table A). The SAME glyph in both states: the state is said by `aria-pressed`, the fill and the border, never by colour alone                                                                                                                                                                                              |
| focus        | `focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`                                                                                                                                                                                                                                                                                                                                            |
| tooltip      | the shipped `Tooltip` (hover and focus, default delay), the same text in both states                                                                                                                                                                                                                                                                                                                                                 |
| narrow (P13) | the group wraps under the per-op header as one line: cue, then the toggle. The label stays — the peek's narrowest width has room for both in en and zh (F1, F2), so there is no compact icon-only form (unlike the canvas bar, which is crowded at 32rem)                                                                                                                                                                            |
| motion       | none: it appears and leaves with the read that changes the cue, in both motion modes                                                                                                                                                                                                                                                                                                                                                 |

**Why a toggle, when the canvas's follow is a status.** On the canvas (Part XXVIII), ON is a plain
status because moving the canvas already turns following off, so an ON button would offer nothing. The
card for this control decided otherwise for the peek: the pressed state shows that following is on AND
offers turning it off, since a reader who wants to stop without scrolling has no other way. So it is a
toggle — one `button`, `aria-pressed` — built from the canvas control's resting recipe so the two read
as one family.

## 30.4 What following does to the column

- **Target.** The caret element (`[data-live-caret]`) inside the field that holds it. Only
  `QuickViewMain`'s `scrollTop` is written — never `scrollIntoView`, which would also scroll the
  overlay and the page.
- **Where the caret lands.** The minimal move that puts the caret's line inside the column with
  **48px clear** below it (scrolling down) or above it (scrolling up, to the title): if it is already
  inside that band, nothing moves. 48px is two lines of body text, so the reader sees the line being
  written and room for the next one, without the column re-centring on every read.
- **When.** Once on the press, then after each read that rendered (after layout, the same frame
  `LiveDraftField` draws the caret in), while following is ON.
- **Motion.** The press scrolls `smooth` in the default mode — it can be a long trip, and the reader
  should see where they are being taken. Every later read is instant (`behavior: 'auto'`): reads
  arrive often, and stacked smooth scrolls lag behind the text. Under `prefers-reduced-motion: reduce`
  the press is instant too (F8).
- **Upward.** When the title grows while the reader is following near the bottom (rare: the model
  writes title → description → explanation), the column scrolls UP to it. Following follows the caret,
  not the bottom — the reason this is a control and not a stick-to-bottom.
- **Scroll anchoring stays on.** §29.5's `overflow-anchor: auto` is unchanged; it keeps the reader's
  place while NOT following, and when following the follow move runs after it.

## 30.5 Telling the reader's scroll from the follow's own

**Following is turned off by the reader's INTENT to scroll, read from the input events that cause a
scroll, never from the `scroll` event.** The follow's own `scrollTop` write and the browser's scroll
anchoring both fire `scroll` too, so a `scroll` listener cannot tell them apart without a timing
window or a "this one was mine" flag, both of which race. Input events are only ever the reader's.

| input, on `QuickViewMain` (the main column)                                                                                     | while following                         |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `wheel` (mouse wheel, trackpad) — listener `{ passive: true }`                                                                  | OFF, in the same frame, before the move |
| `touchstart` (a finger on the column) — `{ passive: true }`                                                                     | OFF                                     |
| `pointerdown` whose `target` is the column itself (its scrollbar; a press on text targets the text, and selects it — no change) | OFF                                     |
| `keydown` of ↑ ↓ PageUp PageDown Home End Space Shift+Space while focus is inside the column                                    | OFF                                     |
| the follow's own `scrollTop` write; scroll anchoring; content growing                                                           | never OFF — no `scroll` event is read   |
| any input on the RAIL (its own scroller) or the header                                                                          | never OFF — it does not move the column |

Turning OFF changes nothing else: the reader's input then scrolls the column natively, from where it
was. Turning ON again is only the control.

## 30.6 Keyboard and screen readers

| element / act               | disposition                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reaching the control        | Tab: it is the next focus stop after the op chip region (an `add` has no key link), before Close / the open-target link                                                                                                                        |
| turning following on / off  | **Enter or Space** on the focused control. Focus stays on it, so a second press turns it off again                                                                                                                                             |
| turning it off by scrolling | the scroll keys above, with focus in the main column (Tab into it, or click in it); the control then reads `aria-pressed="false"`                                                                                                              |
| its name                    | the visible label, _Follow the writing_, in both states — WAI-ARIA's toggle-button rule: the name of an `aria-pressed` button must not change with its state, or a screen reader says _Following, pressed_ / _Follow the writing, not pressed_ |
| its state                   | `aria-pressed`; announced by the screen reader on the press, as for any toggle. No live-region text is added, so the cue stays the ONE live region (§29.6)                                                                                     |
| it leaves while focused     | when writing ends with focus on the control, focus moves to the next focus stop in the header (Close, or the open-target link on a `modify` / `remove`), so focus is never dropped to `<body>`                                                 |
| the tooltip                 | the shipped `Tooltip` on hover and focus; supplementary, never the only place a fact lives                                                                                                                                                     |
| contrast                    | label `--el-text-secondary` resting (≥ 6.18:1 on `--el-card`); pressed label `--el-accent-on-surface` on `--el-tint-lavender`, the pair `inkContrastLint` already asserts over every palette × theme; the glyph is a graphic (3:1)             |

## 30.7 Copy — `messages/en.json` and `messages/zh.json`

| key                              | `en`                                                   | `zh`                                           | where                        |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------- | ---------------------------- |
| `planReview.peekLive.follow`     | `Follow the writing`                                   | `跟随撰写`                                     | the control's label and name |
| `planReview.peekLive.followHint` | `Keep the text being written in view. Scroll to stop.` | `让正在撰写的文字保持在视野内。滚动即可停止。` | the tooltip                  |

**Label:** _Follow the writing_. **Pressed-state label:** the same, _Follow the writing_ — the state is
`aria-pressed` plus the pressed fill and border (§30.6 says why it does not change). **Accessible
name:** the label (no `aria-label`). **Tooltip:** _Keep the text being written in view. Scroll to
stop._ — the one fact the label cannot carry: how to stop.

**Why these words over the alternatives.**

- _Follow the writing_ — pairs with the cue right before it (_Being written_) and with the overlay's
  shipped _Follow the planner_ (§28.7): one verb for one behaviour across the overlay. It names what
  is followed (the writing, wherever it is), which matters because the caret moves between fields.
- _Following_ as a pressed-state label (the card's recommendation) — not taken: a toggle whose name
  changes breaks the toggle-button pattern above; the pressed fill already says it is on.
- _Follow along_ — vague: along what?
- _Follow the cursor_ — the caret is not the reader's cursor, and _cursor_ reads as the mouse pointer.
- _Keep up with the writing_ — longer, and it is the view that keeps up, not the reader.
- zh _跟随撰写_ follows _跟随规划器_ (§28.7) and _正在撰写_ (§29.8).

`planReview` is the namespace the peek already reads (`peekLive.beingWritten`, `peekLive.written`).
The other nine locales follow the catalogue's parity rule in the code card (MOTIR-11248).

## 30.8 Token and shape roles

| element           | colour                                                                       | shape                                       | motion                                           |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| control, resting  | `--el-card` on `--el-border`; label `--el-text-secondary`, hover `--el-text` | `--radius-control`, `--spacing-control-x/y` | none                                             |
| control, pressed  | `--el-tint-lavender` on `--el-accent`; label `--el-accent-on-surface`        | as resting                                  | none                                             |
| glyph             | `--el-accent-on-surface`                                                     | `size-3.5`                                  | none                                             |
| focus ring        | `--focus-ring-color`                                                         | `ring-2`                                    | none                                             |
| tooltip           | shipped `Tooltip` (`--el-tooltip-bg` / `--el-tooltip-text`)                  | shipped                                     | shipped                                          |
| the follow scroll | —                                                                            | 48px clear band                             | press `smooth` (reduced: instant); reads instant |

No token is added; no raw colour, no new easing, no new dependency.

## 30.9 How the asset was produced

A temporary vitest file rendered `ProposalPeek` in happy-dom, one sequence of rerenders per state, and
took the dialog panel of each capture; it also rendered the proposed toggle as static markup (the
`FollowPlannerControl` button recipe, `Navigation`, `aria-pressed`). A second temporary file applied
the delta to the captures — the group around the cue, the toggle inside it — and handed them to
`renderMock`, with `components/ui/markdown-editor.css`'s `.motir-prose` rules as `fontCss` because
`theme.css` does not carry them. Board-only liberties: the dialog is drawn static at a fixed size
(928 × 600, the peek's `max-w-[58rem]`; narrow 480 × 560) instead of `w-[90vw]`; the narrow frames drop
the `md:` two-column rail as the overlay's narrow viewport does; F1b draws the tooltip and the focus
ring statically; and a short script at the end of the board sets each main column's `scrollTop` (a
static board cannot hold one) — to the caret by §30.4's rule in the following panels, to a marked point
in F5, to the reader's own position in F4. The script scrolls only the columns, never the page. Every
panel was screenshotted in Chromium and looked at. Both temporary files were deleted.

## 30.10 GIVES / TAKES

- **MOTIR-11248** (the code card) — **TAKES** everything above: the group and its classes, the toggle
  (markup, both states, tooltip, glyph), §30.4's follow rule, §30.5's input-event rule, §30.6's
  keyboard and focus rules, the two message keys (and the nine other locales), and the
  `data-testid`s `quick-view-live-group` and `quick-view-live-follow` (with `aria-pressed`).
- **Part XXIX** — **GIVES** the cue, the caret and `grewLast` (`lib/planning/liveDraft.ts`); takes
  only the dated pointers in §29.5 and P4.
- **Part XXVIII** (`FollowPlannerControl`) — **GIVES** the recipe and the glyph; takes nothing.

## 30.11 What Part XXX does NOT draw or decide

How partial text renders (Part XXIX §29.3); the plan page's peek, which still never shows partial text
(P9); the canvas and list views, including _Follow the planner_; a committed card's quick view; the
planner side that sends drafts; the implementation.
