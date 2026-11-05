# Reports — design notes

Design reference for the **`reports` UI area** — the **chart visual language**
(Story 4.6): a reusable token-aware SVG chart layer plus the two charts that
finish Epic 4, the in-sprint **burndown** and the cross-sprint **velocity**. The
asset is the source of truth for the Story-4.6 UI subtasks **4.6.2** (the chart
primitives), **4.6.5** (mount the burndown), and **4.6.6** (mount the velocity),
which each carry **4.6.1** in `dependsOn`. Built FROM the real design system
(`app/globals.css` `--el-*` / shape tokens + the shipped `components/ui/*`
`Card` / `EmptyState` / `ErrorState`, and the issue-list vocabulary the
sprint/report reuse), so the code subtasks compose the same primitives — no
Pencil→code gap.

| Surface            | Asset                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chart language** | **`charts.mock.html`** (HTML mockup) | The net-new CHART visual language. NO chart design existed — `design/` had no `reports/` area, and the sprint (4.4.1) + scrum-board (4.5.1) designs only RESERVED an empty chart SEAM (a dashed placeholder labelled "SEAM · STORY 4.6"), they never drew a chart. Unspecified whole element == NO design, so the 4.6.1 gate produces this. 7 panels: visual language + token table · burndown full · burndown compact · velocity · states · seam placement · a11y. Gates 4.6.2 / 4.6.5 / 4.6.6. |

`design/reports/` is a **NEW design area**. The charts are **pure read surfaces**
over data Stories 4.1 / 4.3 / 4.4 already ship (no new write model, no migration —
the burndown reads the committed baseline + the **1.4.6 `work_item_revision`
trail**; the velocity reads the completed-sprint history). Mirror product: **Jira's
Burndown Chart + Velocity Chart** (decision-ladder rung 1 — verified against
Atlassian's report docs, not asserted).

## The core decision — hand-rolled token-aware SVG, NOT a charting library

The design system routes **all colour through `--el-*`** and **all shape through
element-semantic tokens** (`motir-core/CLAUDE.md`). A third-party chart lib
(Recharts / Chart.js / nivo) ships its own canvas/DOM styling that **bypasses the
swap layer**, pulls ~80–120 kB for two charts, and fights the a11y model — so per
the no-shortcut / justified-deviation rule, **4.6.2 builds small SVG primitives
that consume the design tokens directly**. `package.json` gains no charting
dependency. The primitive is the **"viz from Epic 4" Story 6.3 reuses** for
dashboards, so it is drawn GENERIC (a line/area chart + a grouped bar chart + a
shared frame), not bespoke to sprints.

## NEW `--el-chart-*` series tokens (4.6.2 adds these to globals.css Tier 3)

Every chart colour routes through a NEW Tier-3 `--el-chart-*` token — NEVER a raw
`--color-*` in chart code (the per-component token-growth pattern, CLAUDE.md /
mistake #20). Add to `app/globals.css` Tier 3 (and they inherit the
`[data-theme="dark"]` flip + a future `data-palette` via their `--color-*`
mapping; the mockup's Toggle-dark confirms parity):

| Token                  | Maps to                | Role                          |
| ---------------------- | ---------------------- | ----------------------------- |
| `--el-chart-guideline` | `--color-stone`        | burndown ideal line (dashed)  |
| `--el-chart-actual`    | `--color-primary`      | burndown actual remaining     |
| `--el-chart-scope`     | `--color-warning`      | scope-change marker           |
| `--el-chart-committed` | `--color-info`         | velocity committed bar        |
| `--el-chart-completed` | `--color-success`      | velocity completed bar        |
| `--el-chart-average`   | `--color-charcoal`     | velocity average (dashed ref) |
| `--el-chart-plot`      | `--color-surface-soft` | plot background fill          |
| `--el-chart-grid`      | `--color-border`       | gridlines                     |
| `--el-chart-axis`      | `--color-steel`        | axis line + tick labels       |

## This surface REUSES existing vocabularies (reference, don't redraw)

- **`Card`** (`components/ui/Card.tsx`) — the chart container: `--radius-card`,
  `--shadow-subtle`, `--spacing-card-padding`. Each chart (header form, report
  form) sits in a Card with a serif title + a muted sub-line.
- **`EmptyState` / `ErrorState` / skeleton** — the unestimated / low-history /
  loading / error states reuse the shipped idioms (the 3.2.2 scaffold), NOT a
  chart-bespoke state. The chart slot reuses the **surrounding surface's**
  skeleton + `ErrorState` (the scrum header's, the sprint report's).
- **The scrum header (4.5.1 / 4.5.3) + the sprint report (4.4.1 / 4.4.6)** — the
  two host surfaces are **REFERENCED (greyed), never redrawn** (panel 5). 4.6
  fills the chart SEAMS they reserved; it does not restructure either surface or
  touch the numeric summaries (the 3.2-Filter-seam / 4.4–4.5-seam pattern).

## The asset is multi-panel (review EACH)

0. **Chart visual language.** The reusable scaffold 4.6.2 builds into the shared
   frame — the plot frame, the X/Y axes + tick labels, the gridlines, and a
   **visible text legend** (colour is never the sole signal — finding #35). Plus
   the `--el-chart-*` token table above. Responsive SVG `viewBox` +
   `preserveAspectRatio`; a tiny linear-scale helper, **no d3**.
1. **Burndown — full form (sprint-report seam).** Y = points remaining (note the
   issue-count fallback), X = sprint days. The **guideline** (ideal straight line,
   committed → 0) + the **actual remaining** (a STEP line that DROPS on a
   done-category transition and RISES on a mid-sprint scope add). A **scope-change
   marker** (a `--el-chart-scope` diamond + "+N scope"), the **committed baseline**
   labelled at t=0, and the completed end-point labelled. The end-point equals
   `rollupForSprint().remaining` (4.3.3). A completed sprint draws the actual line
   to `completedAt`.
2. **Burndown — compact form (scrum-header seam).** The SAME `LineChart` with a
   smaller frame, Y topping at the committed baseline, the actual line drawn only
   to **"today"** (a dashed vertical marker) for the LIVE sprint, and scope markers
   omitted for density. Mounts BESIDE the numeric remaining, never replacing it.
3. **Velocity.** A grouped **bar** chart over the **last N completed sprints**
   (N = 7, the Jira default): per sprint a **committed** bar (`--el-chart-committed`,
   the locked 4.4.2 `committedPoints`) + a **completed** bar (`--el-chart-completed`,
   `rollupForSprint().completed` from 4.3.3 — the same done-category aggregate the
   scrum header uses, so bars match those surfaces), with value labels, sprint
   names on X, points on Y, and a dashed **average-completed** reference line +
   readout (the planning forecast). Sprints ordered oldest → newest.
4. **States.** **Unestimated** → "no point data" / the issue-count fallback,
   shows "—", never `NaN` (the 4.5.2 "—" rule — the data layer stays total,
   returns 0/null; the UI owns the "—"). **Empty sprint** → a flat guideline at 0.
   **Low-history velocity** (0–1 completed sprints) → "not enough history yet", not
   an axis-of-one. **Loading** → the host surface's skeleton. **Error** → the host
   surface's `ErrorState` with a Retry.
5. **Seam placement.** The compact burndown DROPS INTO the **Story-4.5
   scrum-header chart slot** (beside the committed/completed/remaining stats); the
   full burndown + the velocity chart DROP INTO the **Story-4.4.6 sprint-report
   chart seam** (the 4.4.1 design's labelled "SEAM · STORY 4.6" slot), the two
   presented together as the report's analytics. The header/report chrome is
   REFERENCED (greyed), not redrawn. **No new "Reports" nav surface** — that is
   **Story 6.3**, which reuses this primitive.
6. **A11y.** Every chart is conveyed as **text + number**, never colour/shape
   alone (finding #35): `role="img"` + an `aria-label` / `aria-describedby` →
   `<desc>` summary of every series + endpoint; a **visible text legend**; **value
   labels** on the velocity bars + the burndown baseline/end-point; and a
   **data-table fallback** (the `<details>` "View data table" disclosure → a real
   `<table>` with row/col headers) so the chart is re-expressed as numbers. The
   committed/completed pair is distinguished by **text label**, not the blue/green
   alone — it survives greyscale + colour-blindness.

## Tokens, shape, a11y

- **Colour via `--el-*` only** (no Tier-0 `--color-*` in chart code): the new
  `--el-chart-*` series tokens above, plus `--el-text*` for labels, `--el-surface*`
  / `--el-border` for the Card/plot, `--el-danger` for the error state, the pastel
  tints for the alert flags. AA holds: chart-series hues are vivid line/bar fills,
  and any chip puts the hue in the tint BACKGROUND with `--el-text-strong` text
  (finding #35 / #54); no page-level surface tint.
- **Shape via element-semantic tokens** (no raw `rounded-*`/`p-*`/`h-*` for a
  control's own box): `--radius-card` (chart Card / state boxes), `--radius-control`
  (skeleton bars / small affordances), `--radius-badge` (pills / flags),
  `--radius-btn` (the Retry button), `--spacing-card-padding`, `--shadow-subtle`.
  `rounded-full` only for the status dot. SVG geometry (bar `rx`, point `r`,
  stroke widths) is intrinsic chart shape, not a swappable surface.
- **a11y:** each chart is a `role="img"` figure with a describedby summary + a
  visible legend + value labels + a `<table>` fallback (above). The data tables
  carry `<caption>` + `scope`-ed headers. The series read as text+number; colour
  and shape are never the sole signal.

## Out of scope (documented elsewhere)

- A standalone **Reports / dashboards** navigation surface, configurable widgets,
  and the created-vs-resolved / status-distribution reports — **Story 6.3**, which
  REUSES the 4.6.2 chart primitive (kept generic for exactly this).
- A **cumulative-flow diagram** and other Jira reports beyond burndown + velocity
  (no use case yet — no complexity for nothing).
- **Working-days / non-working-day shading** on the guideline — the project has no
  working-days calendar config yet; the guideline uses calendar days (a future
  refinement when a calendar lands).
- Per-user / per-epic burndown variants; **exporting** a chart to image/CSV.
- The chart **data derivation** — the bounded `getBurndownSeries` (4.6.3) +
  `getVelocity` (4.6.4) services, and the host surfaces themselves (the scrum
  header 4.5, the sprint report 4.4.6) — consumed by these UI subtasks, not built
  here.
- The at-scale combined Scrum journey that also exercises these charts — **Story
  4.7** (the Scrum analogue of 3.5).

---

# Dashboards + Reports — design notes (Story 6.3 · subtask 6.3.3)

Design reference for the **dashboards surface + the Reports hub + the two
built-in report pages** (Story 6.3). The 4.6.1 asset above designed only the
chart visual language + the burndown/velocity; the dashboard grid, the two NEW
chart forms (donut + two-series difference/area), and the Reports hub + report
pages were undesigned — the design-gate "NONE exists" case — so 6.3.3 draws them
here. The **"filter missing" degraded widget body is INHERITED** from
`design/work-items/saved-filters.mock.html` panel 6 (6.2.2): referenced, not
redrawn; we add only the in-grid `Choose a filter` reconfigure affordance.

| Surface                  | Asset                                   | Notes                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboards + Reports** | **`dashboard.mock.html`** (HTML mockup) | 8 panels: new tokens · dashboards home (list/switcher/create/empty) · grid VIEW · grid EDIT (layouts/dnd/add-picker/cap) · widget config panels · widget states · Reports hub · the two report pages. Gates 6.3.4 / 6.3.5 / 6.3.6. |

Built FROM the real design system (the 4.6.1 convention): the token block is
copied 1:1 from `app/globals.css` (Tier-0 `--color-*` + Tier-3 `--el-*` + shape
tokens), includes the 4.6.1 `--el-chart-*` series tokens, and EXTENDS Tier 3
with the NEW tokens 6.3.4 must add (below). Shipped primitives only — `Card`,
`Modal`, `Combobox` (menu + day/time-select vocabulary), `Segmented`,
`FormField`/`Input`, `EmptyState`/`ErrorState`, `Pill` tones, the 6.4.1
access-card radio grammar, the 2.5 issue-row vocabulary (`IssueTypeIcon` in the
`--el-type-*` hues + the priority `Pill`), the 3.2 board `dnd-kit` drag grammar.
`--el-*` only (no Tier-0 `--color-*` in markup); shape via element tokens;
AA-safe; READ AS TEXT (legend + counts + percentages + a `<table>` fallback),
never colour alone (finding #35). Render checklist + AA + dark parity confirmed
(`dashboard.png`; toggle dark in the mockup).

## NEW `--el-chart-*` tokens (6.3.4 adds these to globals.css Tier 3)

Extend the 4.6.1 `--el-chart-*` set. Every donut/difference colour routes through
one of these — never a raw `--color-*` (the per-component growth pattern,
CLAUDE.md / mistake #20). They inherit the `[data-theme="dark"]` flip + a future
`data-palette` via their `--color-*` mapping (the mockup's Toggle-dark confirms
parity):

| Token                 | Maps to               | Role                                                               |
| --------------------- | --------------------- | ------------------------------------------------------------------ |
| `--el-chart-cat-1`    | `--color-primary`     | distribution donut segment 1                                       |
| `--el-chart-cat-2`    | `--color-info`        | segment 2                                                          |
| `--el-chart-cat-3`    | `--color-success`     | segment 3                                                          |
| `--el-chart-cat-4`    | `--color-warning`     | segment 4                                                          |
| `--el-chart-cat-5`    | `--color-accent-teal` | segment 5                                                          |
| `--el-chart-cat-6`    | `--color-accent`      | segment 6                                                          |
| `--el-chart-cat-7`    | `--color-charcoal`    | segment 7 (ramp length; see overflow rule)                         |
| `--el-chart-cat-none` | `--color-stone`       | the "None" / unset group — always last, neutral grey               |
| `--el-chart-created`  | `--color-info`        | created-vs-resolved — the created series line                      |
| `--el-chart-resolved` | `--color-success`     | created-vs-resolved — the resolved series line                     |
| `--el-chart-deficit`  | `--color-destructive` | difference fill where **created > resolved** (~22% α, backlog ↑)   |
| `--el-chart-surplus`  | `--color-success`     | difference fill where **resolved > created** (~22% α, catching up) |

## The two chart forms 6.3.4 builds (INSIDE the 4.6.2 SVG layer — no library)

- **Donut** — annular segments from `(label, count, percentage)` data, drawn as
  SVG arc paths (`M outer A R R 0 large 1 outer L inner A r r 0 large 0 inner Z`;
  `large = 1` when the segment angle > 180°), starting at top (−90°) clockwise.
  Center hole shows the **total** + a noun ("80 issues"). Colour cycles the
  `--el-chart-cat-1..7` ramp; the **None** group is always `--el-chart-cat-none`.
  **Overflow:** beyond 7 segments the ramp would repeat, so cap visible segments
  and roll the remainder into a **"+N more"** legend row (never indistinguishable
  repeats). The **visible text legend** carries count + percentage per segment —
  colour is never the sole signal (finding #35). The widget uses a compact
  side-legend; the report page a larger one. Both ship the `<table>` data
  fallback (the 4.6.1 a11y pattern). Zero data → the empty state (never `NaN`
  geometry).
- **Two-series difference/area** — created (`--el-chart-created`) vs resolved
  (`--el-chart-resolved`) lines over day/week/month buckets, reusing the 4.6.2
  axes/gridlines/ticks/legend. The **difference is shaded**: `--el-chart-deficit`
  (red, ~22% α) where created sits above resolved (backlog growing),
  `--el-chart-surplus` (green, ~22% α) where resolved sits above created
  (catching up) — split at each crossover. The cumulative variant is just data
  (running-sum), no separate form. Reinforced by which line is on top + the
  legend labels, so it survives greyscale (finding #35). The report page ships
  the `<table>` fallback.

## Widget-type ↔ registry mapping (the 6.3.1 UI contract)

The widget-type registry (6.3.1) is TOTAL over the three types; the UI renders
its **editor kind** (config panel) + **renderer kind** (body) — it never
hard-codes the type list, so a registry addition appears in the add-picker + as
a config panel with **zero UI change** (asserted in 6.3.5 with a test-only
registry entry).

| Type                  | Source line / data source      | Config editor kind (panel 4)                                               | Renderer kind (body)                                                                                      |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `filter_results`      | `savedFilterId` \| `projectId` | data-source XOR + rows-per-page stepper (≤50, the verified gadget cap)     | compact issue table (2.5 row vocab: key · type glyph · summary · priority Pill · assignee avatar) + pager |
| `distribution`        | `savedFilterId` \| `projectId` | data-source XOR + statistic-type Combobox (the TOTAL statistic registry)   | the **donut** + text legend (count + %)                                                                   |
| `created_vs_resolved` | `savedFilterId` \| `projectId` | data-source XOR + period Segmented + days-back stepper + cumulative Toggle | the **difference/area** form                                                                              |

The **data-source XOR** is one shared control — a Segmented `Saved filter | Project`
that swaps the Combobox below it, so exactly one of `savedFilterId` / `projectId`
ever sets (the 6.3.1 422 on both/neither). The **report pages (6.3.6) reuse the
SAME editor kinds at page level** — one control vocabulary, two hosts.

## Widget states (per-widget isolation — one failure never breaks the grid)

`loading` (skeleton in the body's shape) · `error` (`ErrorState` + Retry) ·
`empty` (zero matching issues) · **`no-access`** (the 6.4 per-VIEWER gate — a
locked card leaking no counts/rows/chart shape; a workspace-shared dashboard
renders for everyone but each widget read is gated per viewer) · **`stale`** (the
INHERITED 6.2.2 "Filter missing" body + the in-grid `Choose a filter` action).
The dashboard caps at **20 widgets** (the grid shows the cap note + disables
`Add widget`).

## Access + sharing (the recorded narrowing)

`access` is `private | workspace` with **owner-only edit** (create = any member;
the create modal asks only name + access via the 6.4.1 access-card grammar). The
dashboards home groups **My dashboards** (full edit) vs **Shared with the
workspace** (a `View only` chip, overflow hidden). Site = the **workspace** (the
shell's outer boundary, rung 2) at `/dashboard`.

## Extension slots (documented, each justified — not built here)

- The Jira **audience matrix** (user/group/role/public viewer + editor lists) —
  the `access` enum grows into it; `private | workspace` ships.
- **Default/system dashboard**, **starring**, **wallboard/slideshow** mode —
  presentation-layer extensions.
- **Per-gadget auto-refresh** — needs a polling story.
- **More gadget types** (Assigned to Me, Activity Stream, Two-Dimensional
  Statistics, Average Age, Resolution Time) + **more report types** — registry
  additions (the add-picker + Reports hub both render from their registries).
- **Column config** on filter-results (fixed sensible columns ship; a picker is
  additive); **version overlays** on created-vs-resolved (no version entity).

## Out of scope (built elsewhere, consumed here)

- The widget/report **data reads** — `dashboardsService` CRUD/move (6.3.1) + the
  `reportsService` aggregations (6.3.2: created-vs-resolved buckets, distribution
  group-by, filter-results page, per-viewer gating). This asset is pure UI.
- The **chart primitives** themselves — 6.3.4 builds the donut + difference/area
  into the 4.6.2 layer from this spec.
- The **agile report surfaces** the Reports hub links into (burndown / velocity /
  sprint report) — shipped by 4.4–4.6; referenced greyed, never redrawn.

---

# More reports — average age · resolution time · workload (Story 8.8 · subtask 8.8.7)

Design reference for the **three NEW report pages** the Reports hub’s “More
reports” placeholder always named — **Average age**, **Resolution time**, and
**Workload** — plus the hub change that turns the dead dashed _Extension_
placeholder into three live, clickable cards. The 6.3.3 asset above shipped the
hub with a deliberately-disabled `HubCardDisabled` (“Average age, resolution
time, workload — registry additions”); 8.8.7 makes good on it: Yue’s decision is
to **build them for real**. Drawn in the grammar of the shipped report pages
(Created-vs-Resolved, Status distribution), reusing `ReportPageChrome`, the
panel-4 report-control vocabulary, the 4.6.2 SVG chart layer, the legend +
`<details>` data-table a11y pattern, and the panel-5 states.

| Surface          | Asset                                      | Notes                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **More reports** | **`more-reports.mock.html`** (HTML mockup) | 6 panels: new tokens · the UPDATED Reports hub (live cards, no placeholder) · average-age page · resolution-time page · workload page · access path + shared states. Built from the shipped design system + the 4.6.1/6.3.4 chart language. Gates **8.8.13** (implementation). |

Mirror product: **Jira’s Average Age / Resolution Time / Workload reports**
(decision-ladder rung 1 — verified against Atlassian’s report docs, not asserted:
Average Age = a bar of average days unresolved over time; Resolution Time = a bar
of average days-to-resolve over time; Workload = relative open work by assignee).

## The three reports (chart type + controls + data)

| Report              | Route                      | Chart                                                | Controls (reused panel-4 vocab)                   | Data (8.8.13 — `reportsService`, bounded grouped query)                                                                                                                              |
| ------------------- | -------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Average age**     | `/reports/average-age`     | vertical **bar** + dashed window-average             | Scope XOR · Period (day/week/month) · Days back   | per bucket, the avg of `(periodEnd − createdAt)` over issues NOT yet in a **done-category** status at that period end (`getTerminalStatusKeys`); from the 1.4.6 revision trail       |
| **Resolution time** | `/reports/resolution-time` | vertical **bar** + dashed window-average             | Scope XOR · Period (day/week/month) · Days back   | per bucket (keyed by resolution date), the avg of `(resolvedAt − createdAt)` over issues that entered a done-category status in that period; `resolvedAt` = the done-cat transition  |
| **Workload**        | `/reports/workload`        | horizontal **ranked bar** (per assignee, descending) | Scope XOR · Measure (Story points \| Issue count) | current `work_item` rows grouped by `assigneeId`, **unresolved** (non-done-category) only; the unassigned bucket is the neutral “None”, always last; one bounded query, no rev trail |

- **Average age + Resolution time reuse the 4.6.2 vertical-bar primitive** (the
  velocity bar). Y = days, X = period buckets; a **value label** above each bar +
  a dashed **`--el-chart-average`** window-average line with a legend readout (the
  velocity-average idiom). Empty bucket → “—”, never `NaN` (the 4.5.2 rule). The
  two reports share the **same terminal-status (`getTerminalStatusKeys`)
  deviation** Created-vs-Resolved uses — there is no Resolution field — so all
  three throughput reports agree on what “resolved” means.
- **Workload is a horizontal RANKED bar, NOT Jira’s pie — a justified deviation
  (rung 1).** Jira’s Workload report is a pie by assignee, but a pie reads poorly
  for a magnitude RANKING across a team-sized set and the shared 6.3.4 donut
  degrades past 7 segments (the “+N more” roll-up). Workload’s job is _who is
  carrying how much_ — a ranking — which horizontal bars sorted descending read
  directly, with no overflow cliff. The one-line justification is written into the
  card per the no-shortcut/justified-deviation rule. **Measure = story points**
  (Motir has no time-tracking, so points are the workload unit; Jira’s time-field
  picker maps to our Story-points ↔ Issue-count toggle). Bars cycle the
  `--el-chart-cat-1..7` ramp; the unassigned bucket uses `--el-chart-cat-none`.

## NEW `--el-chart-*` tokens (8.8.13 adds these to globals.css Tier 3)

Only **two** net-new tokens — the rest REUSE the 4.6.1/6.3.4 set (the dashed
`--el-chart-average` line; the categorical ramp for workload). Every chart colour
still routes through an `--el-chart-*` token, never a raw `--color-*` (mistake #20
growth pattern); both inherit the `[data-theme="dark"]` flip via their mapping
(the mockup’s Toggle-dark confirms parity).

| Token                   | Maps to           | Role                                    |
| ----------------------- | ----------------- | --------------------------------------- |
| `--el-chart-age`        | `--color-warning` | average-age bar (aging backlog → amber) |
| `--el-chart-resolution` | `--color-info`    | resolution-time bar (throughput → blue) |

## The hub change (the access path’s first door)

The dead `HubCardDisabled` “More reports · Extension” placeholder is **REMOVED**;
its three named reports become live `HubCard` links in the **Issue analysis**
group (which grows 2 → 5 cards on the same `lg:grid-cols-3` grid, wrapping to a
second row). Icons: `clock` (average age), `timer` (resolution time), `users`
(workload). These cards ARE the entry affordance — **the access path is drawn
end-to-end** (the design-content rule): the shell **Reports** nav link → the
Issue-analysis **card** → the **report page**, and `ReportPageChrome`’s “Back to
reports” crumb reverses it (panel 5 draws the whole path explicitly).

## Each is a REGISTRY report (the 6.3.1 widget-type registry)

8.8.13 adds `average_age` / `resolution_time` / `workload` to the **dashboard
widget-type registry** (`lib/dashboards/widgetRegistry.ts`) — the TOTAL map
6.3.3 designed against. Because the hub + the dashboard add-picker both render
from their registries, the three reports also become **dashboard gadgets with
zero extra UI** (the documented registry-addition slot the 6.3.3 notes reserved:
“More gadget types (… Average Age, Resolution Time) + more report types — registry
additions”). New renderer kinds: `bar` (average-age + resolution-time) and
`hbar` (workload) extend the 4.6.2 SVG layer; new editor kinds reuse the
data-source XOR + a Period/Days-back or Measure control.

## States (REUSED verbatim from panel 5 / 6.3.3)

`loading` (skeleton in the chart’s shape) · `empty` (report-specific zero-data
copy — “Nothing resolved yet” / “No open work assigned yet”) · `error`
(`ErrorState` + Retry) · **`no-access`** (the 6.4 per-viewer gate — a saved-filter
scope the viewer can’t see leaks no figures) · **`stale`** (the inherited 6.2.2
“Filter missing” body + `Choose a filter`) · page-level **no-project** empty
state. Every state is carried by TEXT, never colour alone (finding #35); each
chart is a `role="img"` figure with a describedby summary, a visible legend +
value labels, and a `<details>` data-table fallback.

## Tokens, shape, a11y

- **Colour via `--el-*` only** — the two new bar tokens + the reused
  `--el-chart-average` / `--el-chart-cat-*` ramp, plus `--el-text*` for
  labels/legends, `--el-surface*` / `--el-border` for the Card, `--el-danger` for
  the error state. AA holds (bars are vivid fills; chips put the hue in the tint
  background with `--el-text-strong`).
- **Shape via element-semantic tokens** — `--radius-card` (report Card / state
  boxes), `--radius-control` (skeleton bars / hub-card icon), `--radius-badge`
  (pills), `--radius-btn` (Retry / Choose a filter), `--spacing-card-padding`,
  `--shadow-card` (the highlighted hub card). SVG bar `rx` / point `r` / stroke
  widths are intrinsic chart shape.
- **a11y** — `role="img"` + `<desc>` per chart, a visible legend, value labels on
  every bar, and a `<table>` fallback (`<caption>` + `scope`-ed headers). The
  series read as text + number; colour is never the sole signal.

## Out of scope (built elsewhere / consumed here)

- The **data reads** — the new `reportsService` aggregations (average-age,
  resolution-time, workload) + the widget-registry config schemas — 8.8.13. This
  asset is pure UI.
- The **chart primitives** — the `bar` + `hbar` renderers 8.8.13 builds into the
  4.6.2 SVG layer from this spec.
- **Per-epic / per-component workload variants**, time-tracking-based workload
  (no time-tracking entity), CSV/image export — no use case yet (no complexity
  for nothing).

---

# Sprint cycle graph — Linear-style scope vs completed (Story 8.14 · subtask 8.14.1)

Design reference for the **reframed sprint burndown**: Linear's
[**cycle graph**](https://linear.app/docs/cycle-graph) (verified rung-1 standard)
— a burn-**UP** of **live scope vs completed** over the sprint window, replacing
the burn-**down**-from-a-frozen-`committedPoints`-baseline the 4.6.1 burndown
drew. **EXTENDS `design/reports/charts`** (4.6): same hand-rolled token-aware SVG,
same `LineChart` multi-series language, same legend + value-label + `<details>`
data-table a11y model (finding #35). It does **not** redraw the chart scaffold —
it composes the same plot frame + `--el-chart-plot/grid/axis` tokens 4.6.2
established and adds a new series family.

| Surface         | Asset                                     | Notes                                                                                                                                                                               |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cycle graph** | **`cycle-graph.mock.html`** (HTML mockup) | 5 panels: tokens + series legend · full ACTIVE chart · COMPLETE + EMPTY states · COMPACT (board-header) variant · access path (4 surfaces). Gates **8.14.5** (the chart component). |

**Why the reframe (grounded, not invented).** The current burndown depends on the
immutable `committedPoints` snapshot taken at `startSprint`. Started with
unestimated items, that snapshot locks to `null` (**MOTIR-1288**), so the chart
degraded to a unitless issue-count line with no anchor and showed the wrong
remaining (**MOTIR-1285**). Linear derives scope **LIVE** from the change trail,
so the snapshot fragility disappears. This asset is grounded in the parent story
(**MOTIR-1297**) and the data subtasks it draws — **MOTIR-1290** (`CycleGraphDto`

- `toCycleGraphDto`) and **MOTIR-1292** (`getSprintCycleGraph`, the live-scope
  service) — it does not invent the data model.

## The four series + the one metric (the `CycleGraphDto` it draws)

The DTO (8.14.2): `days: { date, scope, completed, started, target }[]` (cumulative
points) `+ statistic · committedAtStart · scopeCreepPct · startDate · endDate`.

| Series                   | Render                                                              | DTO field          | Meaning                                                                            |
| ------------------------ | ------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| **Scope** (gray)         | line + faint area; the live ceiling                                 | `days[].scope`     | LIVE total estimate in the sprint; **rises/falls** as items are added/re-estimated |
| **Completed** (blue)     | solid line + area fill; burns **UP**                                | `days[].completed` | points in a done-category by each day                                              |
| **Started** (amber)      | solid line, between completed and scope                             | `days[].started`   | points in progress by each day                                                     |
| **Target** (blue dotted) | dotted; descends startScope → 0 over working days, flat on weekends | `days[].target`    | ideal remaining; **compare to the (scope − completed) gap**                        |
| **Scope creep** (metric) | amber `creep-chip` pill                                             | `scopeCreepPct`    | `(currentScope − committedAtStart) / committedAtStart` — % added after start       |

**Reading the chart:** actual remaining at any day = the **(scope − completed)
gap** at the top; on-track ⇔ that gap sits at or below the dotted **target**. In
the active panel, day 8 shows 17 remaining (46 − 29) vs a 14 ideal — ~3 pts behind
pace. The **today** marker is the dashed vertical (`--el-chart-axis`), the
**scope-add** step is annotated (`+4 scope` diamond), and the **weekend** is a
faint shaded band where the target line holds flat.

## NEW `--el-chart-cycle-*` tokens (8.14.5 adds these to globals.css Tier 3)

Four net-new series tokens — a **collision-free `--el-chart-cycle-*` family**, the
deliberate name decision of this design:

| Token                        | Maps to           | Role                           |
| ---------------------------- | ----------------- | ------------------------------ |
| `--el-chart-cycle-scope`     | `--color-stone`   | live total scope (gray)        |
| `--el-chart-cycle-started`   | `--color-warning` | started / in progress (amber)  |
| `--el-chart-cycle-completed` | `--color-info`    | completed (solid blue)         |
| `--el-chart-cycle-target`    | `--color-info`    | ideal remaining (blue, dotted) |

> **Token collision note for 8.14.5 (MOTIR-1293).** The card sketched the names as
> `--el-chart-completed` / `--el-chart-started` / `--el-chart-target`, but
> **`--el-chart-completed` is ALREADY taken** (velocity's GREEN completed bar), and
> `--el-chart-actual` / `--el-chart-guideline` are the OLD burndown's blue/gray.
> Adding or reusing those bare names would silently re-skin the velocity + legacy
> burndown charts. So this design defines the `--el-chart-cycle-*` family instead
> (the per-component token-growth pattern, CLAUDE.md colour rule). Every cycle
> colour routes through one of these — never a raw `--color-*`. The
> `--el-chart-plot/grid/axis` scaffold tokens are **reused** unchanged. All four
> inherit the `[data-theme="dark"]` flip via their mapping (the mock's Toggle-dark
> confirms parity).

## States + variants (panels 2–3)

- **ACTIVE** (full, sprint-report form) — the headline. Stat row (Scope / Completed
  / Started / Remaining + scope-creep chip), four series to **today**, target across
  the full window, weekend band, today marker, data-table fallback.
- **COMPLETE** — terminal: the chart freezes at sprint end; the gray-scope ↔
  blue-completed gap is the **carried-over** points (surfaced in the report roll-up
  beside the chart).
- **EMPTY / not started** — a planned sprint has no `startDate` window → the
  `state-box` "No cycle data yet" (backs the service's `SprintNotStartedError`,
  8.14.4, mirroring `getBurndownSeries`). Never a degenerate flat line.
- **COMPACT** (board / scrum-header variant) — drops the value-labels + data-table
  chrome, keeps the four series + today marker + `<desc>` + scope-creep chip; mounts
  beside the numeric remaining for an at-a-glance read.

## Access path (panel 4 — drawn, not just named)

The same component + `CycleGraphDto` renders on **four** surfaces; each door is
drawn (the design-content rule):

| Surface                    | Route                              | Form    | Door                                                                                        |
| -------------------------- | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| **Sprint report**          | `app/(authed)/sprints/[id]/report` | full    | the sprint's **View report** action (replaces the burndown seam)                            |
| **Backlog sprint section** | `app/(authed)/backlog`             | full    | the active-sprint panel (where `BurndownChart` renders today)                               |
| **Board sprint header**    | `app/(authed)/boards`              | compact | always-visible beside the numeric remaining                                                 |
| **Reports → Burndown**     | `/reports/burndown`                | full    | the **Reports** nav → **Burndown** entry (label stays "Burndown"; chart is the cycle model) |

8.14.5 builds the component once; **8.14.6** repoints every consumer to the new
DTO/component. The velocity chart and `startSprint`'s snapshot logic are out of
scope (story boundary, MOTIR-1297) — this chart is correct regardless of whether
MOTIR-1288 fixes the snapshot.

## Tokens, shape, a11y

- **Colour via `--el-*` only** — the four new `--el-chart-cycle-*` series tokens +
  the reused `--el-chart-plot/grid/axis` scaffold, `--el-text*` for labels/legends,
  `--el-tint-peach` + `--el-text-strong` for the scope-creep chip, `--el-surface*` /
  `--el-border` for the Card, `--el-tint-lavender` for the active nav door. AA holds
  (series are vivid strokes/fills on the soft plot; the chip puts the hue in the
  tint background).
- **Shape via element-semantic tokens** — `--radius-card` (chart Card / state box),
  `--radius-control` (sketch surfaces / nav door), `--radius-badge` (chips / nav
  pills), `--radius-btn` (toggle), `--spacing-card-padding`, `--spacing-chip-*`,
  `--shadow-subtle`. SVG point `r` / stroke widths / dash arrays are intrinsic chart
  shape.
- **a11y** — each chart is a `role="img"` figure with a `<desc>` narrating every
  series + the on/behind-pace read, a visible read-as-text legend, value labels at
  the endpoints, and a `<details>` `<table>` fallback (`<caption>` + `scope`-ed
  headers). The series read as text + number; colour is never the sole signal
  (finding #35). The today marker + weekend band are labelled, not colour-only.

## Out of scope (built elsewhere / consumed here)

- The **data path** — `CycleGraphDto` + `toCycleGraphDto` (8.14.2 / MOTIR-1290),
  the revision-trail aggregate (8.14.3), and `getSprintCycleGraph` live-scope
  service (8.14.4 / MOTIR-1292). This asset is pure UI.
- The **chart component + tokens** — `BurndownChart` reframed onto `LineChart` with
  the new `--el-chart-cycle-*` tokens (8.14.5 / MOTIR-1293, from this spec).
- **Repointing the consumers** to the new DTO/component (8.14.6).
- The **velocity chart**, dashboards beyond the burndown repoint, and `startSprint`
  snapshot logic — explicit story boundary (MOTIR-1297).

---

## The streaming allocation at ARRIVAL — `/reports/burndown` (MOTIR-3442)

Part of [MOTIR-3440](motir:cmt8s085i003li1ph06u469kx)'s sweep of the 24 heavy authed surfaces. The
rule this applies is `design/shell/design-notes.md` § _The navigation-pending grammar_ →
_WHICH SURFACES EARN A FRAME_, and the three-tier method is
`design/work-items/design-notes.md` § _The item page at ARRIVAL_'s. **Neither is restated here.**
Measured against `origin/main` `9455fc3c`.

|                            |                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `getSession` → `getTranslations('reports')` → `getActiveProject` → `sprintsService.listByProject`, which selects the **no-sprints** empty state and supplies the default sprint                                                                                |
| **with the frame**         | `ReportPageChrome`'s back-link, crumb and title — all `t('reports.*')`. **Its `subLine` is not**: it is `[project.name, selected.name]`, and `selected.name` comes from the gate's own sprint read, so it arrives with the chrome rather than before it        |
| **with the first content** | `searchParams` → the sprint picker (`pickerSprints`, from the same read)                                                                                                                                                                                       |
| **after the page**         | `reportsService.getSprintCycleGraph(selected.id)` — the series the chart draws                                                                                                                                                                                 |
| **settles**                | **twice, deliberately.** The picker is usable while the series is still resolving, which is the whole point: a reader who landed on the wrong sprint can switch before the wrong chart has finished arriving                                                   |
| **verdict**                | **NONE — the chart's own pending state serves.** `BurndownReport` already renders `ReportStateMessage` for its empty and not-started cases and owns the region; the boundary goes around the chart and its fallback is that component's own, not a new drawing |

> ## ⚠️ AMENDMENT — 2026-08-26, MOTIR-3447. NO BOUNDARY IS ADDED, AND THE CARD CONTRADICTS ITSELF ON THIS.
>
> The entry's verdict — **NONE, the chart's own pending state serves** — stands. What does not is the
> sentence that the page _"gains from this story the boundary that lets the chrome and the picker
> paint ahead of the series."_ MOTIR-3447 asks for exactly that in an acceptance criterion, and
> forbids it in its own boundary clause:
>
> - **AC** — _"Each chart page's chrome — heading, sprint picker, period controls — renders BEFORE
>   its series resolves."_
> - **Boundary** — _"does not change any chart component or its internal loading state."_
>
> **The sprint picker is a `Combobox` INSIDE `BurndownReport`** — the chart component. Painting it
> before the series therefore requires splitting that component, which the boundary forbids; and
> wrapping the whole component instead takes the picker behind the fallback with it, buying nothing
> the criterion asked for. The boundary clause won, and `/reports/burndown` ships **no diff**.
>
> The measurement stands on its own: nothing here is parallelisable either. `getSprintCycleGraph`
> takes `selected.id`, and the selection comes from the sprint list that also decides the no-sprints
> empty state — genuinely serial, not incidentally so.

**This answers the card's question directly:** the chart's state serves, and a frame wrapped around
it would be a second pending vocabulary over a region that already has one. What the page gains from
this story is the boundary that lets the chrome and the picker paint ahead of the series — not a
mock.

**A route boundary is declined as a preference** — `/reports/burndown` does not call `notFound()`.

## Reports refined — full width, readable axes, help text, workload period, CvR bars, sprint pickers

**Mock:** [`reports--refined.mock.html`](./reports--refined.mock.html) — a DELTA; only the panels that
change (MOTIR-8920, Story MOTIR-8919). Nothing below edits an older mock; this section amends them by path.

**Amended panels, by file and panel number**

| Existing asset           | Panel(s)                                     | Amended by (this mock) |
| ------------------------ | -------------------------------------------- | ---------------------- |
| `dashboard.mock.html`    | 4–7 — the report chrome, Created vs Resolved | 1, 2, 3, 5             |
| `charts.mock.html`       | 0 (scaffold), 3 (Velocity)                   | 1, 2, 6                |
| `more-reports.mock.html` | 4 (Workload), 5 (access path / states)       | 3, 4, 7                |
| `cycle-graph.mock.html`  | 2–4 (the Sprint report, its access path)     | 1, 6, 7                |

### Panel map

0. New tokens and every number below.
1. Full-width chrome, 1440 and 1920 px, a bounded chart above a 900 px fold; the Sprint report in the same chrome.
2. X labels that never overlap — line, difference-area and grouped-bar forms, daily × 90 at 1280/1440/1920, plus the angled case.
3. The help-text toggle, shown and hidden.
4. Workload with Period and Days back, two-segment bars, the empty window.
5. Created vs Resolved as bars, and the series switches (including the last-series lock).
6. Sprint picker on the Sprint report; Velocity's range control; over the skeleton.
7. The access path (both doors), the bad-sprint-id fallback, and every state.

### Page chrome and the bounded height (panel 1)

- `ReportPageChrome` drops `mx-auto max-w-[48rem]`; the report Card spans the content width.
- **Chart height is `clamp(280px, 44vh, 420px)`** — 396 px at a 900 px viewport, the same at 1440 and 1920. With the Card's stack above it (shell 56, padding 24, back link 24, gap 16, card padding 24, header 88, help text 126, controls 76, legend 40) the x axis ends at ~866 px: above the 900 px fold at both widths, with the help text shown.
- The SVG is measured and drawn at **user space = rendered pixels** (`viewBox` equals width × height), so 11 px axis type is 11 px at every width. Today's `680 × 320` viewBox under `w-full h-auto` grows with width; that is why the cap existed (MOTIR-449).
- The Sprint report adopts the chrome: back link still points at the backlog, title and sprint picker move into the header.

### X-axis labels (panel 2) — the rule, as numbers

| Quantity                  | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Bucket pitch              | plot width ÷ (n − 1) for line / difference area; ÷ n for bars                                                         |
| Margins                   | top 16 · right 16 · left 48 · bottom 46 flat, 64 angled (plot absorbs the 18 px; total height unchanged)              |
| Flat spacing              | label chars × 6.3 px + 12 px; show every ⌈spacing ÷ pitch⌉-th bucket from the first                                   |
| First / last              | both always labelled; an earlier label closer than the spacing to the last is dropped                                 |
| Angle                     | fewer than 8 labels after thinning → rotate −45° (text-anchor end, pivot under the tick) and re-thin at 16 px spacing |
| Result, daily × 90        | 1280 px → every 4th (23 labels) · 1440 px → every 4th (23) · 1920 px → every 3rd (30)                                 |
| Result, 26 weekly, 640 px | flat leaves 7 → angled, all 26 labelled                                                                               |

Hover or focus on any bucket shows the full date and the values, labelled or not. The `<details>` data
table keeps all buckets: thinning is a drawing decision, never a data one.

### Help text (panel 3)

A ghost small `Button` (info glyph · label · chevron) at the header's right edge: **"Hide help text"** /
**"Show help text"**, `aria-expanded`, `aria-controls`. The region is an `--el-tint-lavender` callout
(`--radius-card`, ink `--el-text-strong`) with two paragraphs — **What it shows** and **How to read it**.
Shown on a first visit; once hidden it stays hidden on every report in this browser (one shared
preference in browser storage, no account setting, no URL parameter). Hidden = removed from layout.

### Workload (panel 4)

Controls: Scope · **Period** · **Days back** · Measure (Average age's vocabulary). Each person is a bar of
two segments — **Assigned** and **Unassigned — reported by** — with the split written at the bar's end
("34 = 21 + 13"). Ranked by total, ties by name; the **no-reporter bar is grey and always last**. Colour
now means kind of work, not person, so the per-assignee ramp is not used here. The dashboard Workload
gadget is unchanged. URL: `?period=&daysBack=` beside `?savedFilterId=&measure=`.

### Created vs Resolved (panel 5)

New controls **Chart form** (Line · Bars) and **Series** (Created / Resolved `Switch`es). Bars are the
shipped `BarChart` with one bar per visible series; with one series off the line form drops the
difference shading. **At least one series stays on**: the last-on switch is disabled and the visible text
"At least one series stays on." sits under it. URL (proposal; the code card owns exact values):
`?form=bars` (omitted for line), `?series=created|resolved` (omitted when both).

### Sprint pickers (panel 6)

- **Sprint report:** a sprint `Combobox` (Active, then Completed newest-first — Burndown's grouping) that navigates to `/sprints/<id>/report`.
- **Velocity:** **Ending at** (a completed-sprint `Combobox`, blank = latest) and **Sprints** (stepper over 3 · 5 · 7 · 10 · 15 · 26 · 52, default 7, service cap 52). URL `?endingAt=<sprintId>&count=<n>`; both omitted = today's last 7. Both pickers render in the chrome ahead of the series skeleton.

### Access path and states (panel 7)

Both doors are drawn unchanged (Reports nav → hub card → page; sprint "View report" → page → picker). A
**bad or foreign sprint id opens the default sprint's report with no error, no toast and no message**,
and says nothing about the id it was given (no existence leak). Loading, empty, error and no-access/stale
states keep their existing bodies; the new controls render in each.

### New tokens

| Token                            | Maps to               | Role                                     |
| -------------------------------- | --------------------- | ---------------------------------------- |
| `--el-chart-workload-assigned`   | `--color-primary`     | Workload: assigned segment               |
| `--el-chart-workload-unassigned` | `--color-accent-teal` | Workload: unassigned-by-reporter segment |

Reused with no change: `--el-chart-cat-none` (no-reporter bar), `--el-chart-created` / `--el-chart-resolved`
(CvR bars), `--el-chart-committed` / `--el-chart-completed` / `--el-chart-average` (Velocity),
`--el-tint-lavender` (help region). No raw hue anywhere in the mock; colour is never the sole signal.

### URL parameter names (summary)

`period`, `daysBack` (Workload) · `form`, `series` (Created vs Resolved) · `endingAt`, `count` (Velocity);
the Sprint report uses its path `/sprints/<id>/report`. `buildReportHref` builds them and omits defaults.

## Workload drops Period — Days back only (MOTIR-10346)

Amends **§ Reports refined › Workload (panel 4)** above and its URL summary, drawn in
`more-reports.mock.html` panel 4. No new mock: the change removes one control and redraws nothing.

Workload is a ranked horizontal bar chart with **no time buckets**, so the Period segmented control
(Day / Week / Month) had nothing to bucket: switching it returned identical bars, and its only effect
was the daily bucket cap hiding the 180- and 365-day rungs of Days back. So:

- **Controls:** Scope · **Days back** · Measure. The Days-back stepper is the same element as before
  (same markup, tokens and labels); its ladder is 7 · 14 · 30 · 60 · 90 · 180 · 365 for every reader,
  bounded only by the one-year window cap.
- **URL:** `daysBack` (Workload) beside `?savedFilterId=&measure=`. The page ignores a `?period=`, so an
  old shared link that still carries one renders the same bars as the link without it.
- **Copy:** the chart description, the data-table caption and the help text say "the chosen window",
  not "the chosen period".
- Average age, Resolution time and Created vs Resolved keep Period — there it buckets the axis.
