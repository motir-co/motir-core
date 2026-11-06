# `design/shell/` — the app shell

The authed shell: the top bar, the persistent sidebar rail, the off-canvas drawer, and the two
overlays the bar summons. This is the area's first `design-notes.md`; the five `.pen` assets beside it
predate the three-file convention and are indexed below rather than rewritten.

| Surface                                           | Asset                                                           | Card                        | State                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Desktop shell @1440 — bar + rail + content        | `desktop.pen` / `.png`                                          | MOTIR-53 (1.5.1)            | Stale in the right cluster only: draws 3 controls of the 8 that ship                                 |
| Desktop shell, rail collapsed                     | `desktop-collapsed.pen` / `.png`                                | MOTIR-53                    | Same                                                                                                 |
| Narrow width — bar closed, drawer open            | `mobile-drawer.pen` / `.png`                                    | MOTIR-53                    | **Superseded by `top-bar.mock.html`** for the right cluster + the drawer's footer                    |
| ⌘K command palette                                | `cmd-k.pen` / `.png`                                            | MOTIR-53                    | Current (panels: _Empty query_, _Filtered: 'iss'_)                                                   |
| Shortcuts cheatsheet                              | `shortcuts.pen` / `.png`                                        | MOTIR-53                    | Current                                                                                              |
| **The top bar's control budget**                  | **`top-bar.mock.html` / `top-bar.png`**                         | **MOTIR-2374**              | **The design of record for what the bar carries at each width**                                      |
| **The context row — the left cluster**            | **`context-row.mock.html` / `context-row.png`**                 | **MOTIR-2555**              | **The design of record for the `org › workspace › project` path, the rail head, and the brand tile** |
| **The navigation-pending grammar**                | **`navigation-pending.mock.html` / `navigation-pending.png`**   | **MOTIR-3431**              | **The design of record for what the content area shows between the click and the arrival**           |
| **The rail's BOTTOM section**                     | **`rail-bottom-section.mock.html` / `rail-bottom-section.png`** | **MOTIR-4130** · MOTIR-4167 | **The design of record for every row that section renders, at all three widths, in both arms**       |
| **The no-project shell (Limited, added to none)** | **`no-project--limited.mock.html`**                             | **MOTIR-6540**              | **The ONE no-project state that returns — a Limited member who can open nothing; see § below**       |

---

## The content column reserves the floating orb's footprint (MOTIR-2763)

**The shell's content column pays the clearance for every piece of floating furniture the shell
mounts. A bottom-anchored control on any page must NOT reserve space for the orb itself.**

`PlanWithAIFab` — the "M" AI callout orb — is `fixed right-5 bottom-5 z-40 h-14 w-14`, so it owns the
viewport rect `y ∈ [bottom−76, bottom−20]` on every authed screen where `showPlanWithAi` holds. Being
`position: fixed` it participates in **no page's flow**: it takes viewport space from every page while
appearing in none of their layouts. Nothing catches that — no page imports the orb, so no type, no
grep and no component test connects the two, and a happy-dom test has no layout engine to see it with.

So the reservation is made **once, at the mount that creates the obstruction** — the content wrapper in
`app/(authed)/layout.tsx`, conditional on the same `showPlanWithAi` that decides whether the orb ships
at all. It is carried by a single custom property:

|                            |                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--shell-bottom-clearance` | `6rem` when the orb mounts, `1.5rem` when it does not. Set on the content wrapper; the wrapper's own `pb-` reads it.                                                                                                                                                        |
| consumers                  | Anything sizing itself against the fold subtracts `var(--shell-bottom-clearance, 1.5rem)` instead of hard-coding the wrapper's bottom padding — `BoardColumn`, `plans/[id]`, `RoadmapView`, and the `3d-immersive` board-column rule in `packages/design-system/theme.css`. |

**Two rules follow, and they are the reason this is written down.**

1. **A new bottom-anchored control adds nothing.** Put the pager, the footer row or the action bar
   last and right-aligned exactly as the design asks; the column already holds the space open. A
   control that reserves its own clearance double-pays it, and creates a rule every future author has
   to remember — there were already five such controls when this was found, and the sixth author would
   not have known.
2. **A surface that hard-codes a viewport-relative height MUST spend the variable, not a constant.**
   `h-[calc(100dvh - <chrome above> - var(--shell-bottom-clearance, 1.5rem))]` — never a single baked
   number that silently encodes today's padding. Four surfaces did bake it in, and all four would have
   been pushed past the fold by the clearance had they not been converted with it.

**And the check is a HIT TEST, not a look.** An overlapped control is still perfectly `toBeVisible()`
— visibility is a property of the element and clickability is a property of the stack above it. The
guard is `tests/e2e/cloud-orb-clearance.spec.ts`, which rides the **cloud** lane because that is the
only lane whose webServer sets `MOTIR_AI_URL`; in the main lane the orb does not mount, so the same
assertion would pass on broken code forever.

**Adding floating furniture to the shell is not additive** — it is a claim on viewport space that every
page in the app now pays. Reserving the space is part of shipping the element, in the same commit.

---

## The top bar's control budget (MOTIR-2374)

The code change is **MOTIR-2373**. This asset decides what it builds.

### Why the area owed this

The right cluster grew from three controls to eight, one story at a time, and each addition was
designed — by the area that introduced it, for the desktop width it cared about. No design owned the
total. `design/shell/` does, and every `.pen` here has been drawing a three-control bar since Story
1.5, so the bar reached eight controls without a single design pass ever seeing the eight together.

### What the render found — the facts this design is built on

Every number below was measured, not estimated: the real `app/(authed)/_components/TopNav.tsx` was
server-rendered inside its real providers with the real `messages/en.json`, then laid out in Chromium
against the build's own compiled Tailwind output. Panel A of the mock IS that render — the markup in
those frames is the app's, not a redraw (`notes.html` #73).

Right-cluster width, by viewport and by which optional slots are live:

| Viewport | Private project + AI          | **Public** project + AI                                 | Self-hosted, no AI, private  |
| -------- | ----------------------------- | ------------------------------------------------------- | ---------------------------- |
| 375px    | **350px** — hamburger covered | **409px** — `<nav>` scrolls to 433px, hamburger covered | 208px — fits, with 0px spare |
| 700px    | **656px** — hamburger covered | **670px** — scrolls to 702px                            | 383px                        |
| 1024px   | 706px                         | 717px                                                   | 383px                        |

Three findings the bug did not have, each of which changes what gets built:

1. **The worst band is `sm`–`md` (640–767px), not `< md`.** At 640px every label switches on at once
   and the cluster jumps 350 → 656px inside a 640px viewport — while the hamburger is still mounted,
   because it is `md:hidden` and therefore lives to 767px. A fix scoped to `< md` leaves a 128px-wide
   band broken in exactly the same way, and a hit-test asserted only at 375×812 passes while it is.
2. **`BuildingInPublicHeaderLink` is the one control whose label was never breakpoint-gated.** Every
   other labelled control carries `hidden sm:inline`; this one carries none, so it contributes
   **117px at 375px** where the CTA it replaces contributes 38px. That asymmetry — not the control
   count — is what makes the public state the widest surface in the product.
3. **The cluster is already squeezing its own controls below their box.** In the public state at
   375px the theme toggle and the avatar measure **28px wide against a 36px height**: the avatar's
   `rounded-full` is rendering as an ellipse. The cluster mixes three box sizes today (28 / 36 / 38).

### The budget

The ceiling is set by the smallest viewport the app supports, **320px**, and by the one element that
must never be covered: the hamburger, which below `md` is the only route to the board, the backlog or
settings.

```
320 − 32 (px-4 gutters) − 36 (hamburger) − 8 − 8 (gaps) − 68 (tier-nav floor) = 168px
168 = 4 × 36 + 3 × 8
```

**Four slots below `md`.** The pixels move with `--height-control` (36px default; 40px under
`soft-playful` and `3d-immersive`, 34px under `swiss-minimal-flat` and `cybercore-y2k`) — the slot
COUNT does not. At the widest style the same sum leaves the tier nav 48px, which is a truncated
project name: legible, and the floor this budget accepts.

| Band                   | Left cluster                   | Right cluster                                                      |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `< md` (0–767px)       | hamburger + tier nav, no brand | **4 slots, icon-only, one `--height-control` square each — 168px** |
| `md`–`lg` (768–1023px) | brand + tier nav, no hamburger | **8 slots, icon-only** (the build-in-public slot keeps its label)  |
| `≥ lg` (1024px)        | brand + tier nav               | **8 slots, labelled**                                              |

**The label breakpoint moves from `sm` to `lg`** — labels and their `<kbd>` hint chips together. That
one change is what closes the 640–767px band: at `md` the full set is back but icon-only, and by then
the brand slot has replaced the hamburger, so there is nothing left to cover. Measured on the mock:
`md` public = 468px right + 183px left, 69px of slack; `lg` public = 733px right + 183px left, 63px of
slack at the narrowest `lg` viewport.

Gating the label without the chip is not a half-measure, it is a defect: an icon beside a bare `⌘K`
chip has no label for the chip to attach to, and the chip overflows the square box it no longer fits.

### The context path's truncation budget — the `xl` band (MOTIR-4897)

**This budget made the right cluster `flex-none`, and that moved every shortfall onto the LEFT
cluster at every width — including the top of the range, which the table above never measured.** At
`xl` (1280px is exactly the breakpoint) the context path renders all three tiers, the right cluster
is labelled, and the row's room is set by the NAMES, which are data. The ladder in § _The context
row_ decides which tiers are PRESENT; it cannot decide how wide they are.

**What was observed, in a real run.** The acceptance lane timed out retrying one click on
`Switch project` 638 times at 1280×720; the element Playwright named in its place was the Plan-with-AI
label. Reproduced on `origin/main` with the shape a new cloud tenant is actually given — an org and a
workspace minted with one name, a project named after its workspace (MOTIR-4870), two workspaces, AI
configured and a public project: at 1280px the element at the centre of the project switcher is the
pill's sparkles glyph. The button stays visible, enabled and stable throughout, so no visibility check
sees it.

**The mechanism.** `ProjectSwitcher`'s trigger was already elastic (`min-w-0 shrink`). The two
ANCESTOR triggers were not: `OrgControl` and `WorkspaceSwitcher` are `inline-flex` `Button`s, a flex
child's automatic minimum is its content, and their content is the whole name up to its cap (20ch /
24ch). So the row overflowed, and the tier LAST in it — the project — passed under the right cluster.

**The rule.**

| tier                 | shrinks            | name                                          |
| -------------------- | ------------------ | --------------------------------------------- |
| org (ancestor)       | `min-w-0 shrink-3` | truncates inside `max-w-[20ch]`               |
| workspace (ancestor) | `min-w-0 shrink-3` | truncates inside `max-w-[24ch]`, as a `block` |
| project              | `min-w-0 shrink`   | truncates inside `max-w-[22ch]` — unchanged   |

1. **Every tier is elastic.** No left-cluster child may hold a minimum wider than its chrome; one that
   does re-opens this defect over whichever tier follows it.
2. **The ancestors yield first.** `flex-shrink` is weighted by basis, so a 3 : 1 weight takes most of
   the shortfall from the org and workspace and leaves the most specific tier the most legible — the
   breadcrumb convention § _The ladder_ already follows for which tiers LEAVE, applied to how they
   SHRINK. No tier leaves: the path still reads org › workspace › project.
3. **A truncating name is a box.** `text-overflow` ignores an inline element, and the workspace name
   sits directly in the `Button`'s own label span rather than in a flex row — so it is `block`, or it
   spills instead of ellipsizing. The `Button`'s label span takes `min-w-0` too; its `aria-hidden`
   chevron span keeps its minimum.

**Measured after the change**, in Chromium against the production build, in the seed above (the
widest right cluster, and one long name at all three tiers):

| viewport | org name | workspace name | project name | project tier ends      | each tier at its own centre |
| -------- | -------- | -------------- | ------------ | ---------------------- | --------------------------- |
| 1280px   | 55px     | 56px           | 120px        | 8px before the cluster | yes                         |
| 1440px   | 123px    | 125px          | 143px        | 8px before the cluster | yes                         |

The 8px is the bar's own `gap-2` between the clusters — the row now fits exactly. Every name shows
at least 40px, the floor the guard holds so a squeezed ancestor never becomes a chevron in a box.

**The guards.** `tests/e2e/cloud-top-bar-budget.spec.ts` carries the pixel half at 1280 and 1440px,
in the cloud lane, because that is the only lane where the Plan-with-AI pill mounts;
`tests/components/shell-tier-nav.test.tsx` pins the class contract the geometry follows from. Neither
older guard could see this: the component budget test stubs `ShellTierNav` outright, and the E2E
budget stopped at 700px.

### Every control's disposition below `md`

| Control                                         | `< md`                     | Where it goes instead                                                                                                                                                        | Why that is safe                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CommandPaletteTrigger`                         | **slot 1**, icon-only      | —                                                                                                                                                                            | The universal find, and the door to three of the four displaced controls: `plan-with-ai`, `create-issue` and `acct-theme` are all actions in `AppCommandPalette`.                           |
| `CreateIssueButton`                             | **slot 2**, icon-only      | —                                                                                                                                                                            | The primary write action. A phone is where a thought gets captured; two taps through ⌘K is the wrong cost for it.                                                                           |
| `NotificationBell`                              | **slot 3**, icon + badge   | —                                                                                                                                                                            | **The only control with no second door.** `/settings/account/notifications` is preferences, not a feed, and a badge inside a closed drawer conveys nothing.                                 |
| `UserMenu`                                      | **slot 4**, avatar         | —                                                                                                                                                                            | The sole path to account settings and sign-out, and the identity anchor of the bar.                                                                                                         |
| `PlanWithAILauncher`                            | **dropped**                | `PlanWithAIFab` — the floating orb, mounted on every authed screen behind the same `showPlanWithAi` gate (`app/(authed)/layout.tsx:279`) — plus the ⌘K `plan-with-ai` action | Two doors already ship at 375px. This is the one control that can leave the bar and cost nothing, which is why it leaves first.                                                             |
| `ThemeToggle`                                   | **drawer strip**           | The drawer's utility strip; also ⌘K `acct-theme` and `/settings/account/appearance`                                                                                          | A preference, changed rarely, with two working second doors.                                                                                                                                |
| `ReportButton` (`display="shell"`)              | **drawer strip**           | The drawer's utility strip                                                                                                                                                   | No ⌘K action exists for it, and `/triage`'s inbox CTA is a different act — reporting from the queue, not about the screen you are on. So it needs a drawn home, not a citation.             |
| the build-in-public slot (CTA **or** indicator) | **drawer strip**, labelled | The drawer's utility strip, keeping its label                                                                                                                                | A status stripped of its label is not a status. The drawer has the width the bar does not — and displacing BOTH of its states is what stops the two-state slot from being a width variable. |

At 375px the private and public bars now measure **identically (168px)**, because the slot that made
them differ is no longer in the bar.

### The rule for the ninth control

> The below-`md` bar is **closed at four slots**. A control added to the right cluster is a
> `md`-and-up control by default. To appear below `md` it must displace one of the four, and the
> displaced one must land in the drawer's utility strip — drawn, not cited. A control whose label is
> not breakpoint-gated does not qualify for the bar at all until it is: that is exactly how the widest
> state in the product came to exist.

This is the sentence `TopNav`'s docstring should record (MOTIR-2373's last acceptance criterion). A
docstring can only record a rule someone decided; this is where it was decided.

### The access path — the drawer's utility strip (Panel D)

The door is the hamburger the bar already carries. The room is a **footer strip** on `SidebarDrawer`,
with the geometry of the drawer's own header, mirrored to the bottom edge:

```
flex h-14 shrink-0 items-center gap-2 border-t border-(--el-sidebar-border) px-3
```

It holds, left to right: the build-in-public slot (labelled, in a `min-w-0 flex-1` wrapper so it
truncates rather than pushing), then `ReportButton`, then `ThemeToggle` as their shipped square icon
buttons. **Nothing in the strip is a new component** — each control is the element that left the bar,
re-homed. That is also why the strip is a horizontal row rather than `SidebarItem` rows: a
`SidebarItem` is an `href` link, and three of these four are buttons or stateful slots.

### Primitives and tokens

Every element names what it composes from. No element in this asset introduces a colour or a shape
value of its own.

| Element                | Primitive / component                                | Colour                                                                        | Shape                                                                               |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| the bar                | `<header data-surface="header">` + `<nav>`           | `--el-page-bg`, bottom hairline `--el-border`                                 | `h-14`, `px-4` / `sm:px-6` gutters, `gap-2`                                         |
| hamburger              | `SidebarToggle variant="hamburger"` → `Button` ghost | `--el-text-muted` → `--el-text` on hover over `--el-surface`                  | `--height-control` square, `--radius-control`                                       |
| brand slot             | `BrandMark variant="mark" size={24}`                 | the mark's own                                                                | `--radius-control`; `hidden md:flex` (design/brand §7a)                             |
| tier nav               | `ShellTierNav`                                       | `--el-text`, separator `--el-text-faint`                                      | `min-w-0`, truncates — the only elastic element in the bar                          |
| search · create        | `CommandPaletteTrigger` · `CreateIssueButton`        | `--el-text-muted` → `--el-text`, hover `--el-surface`, hairline `--el-border` | `--height-control` square below `lg`, `--radius-btn`; `--radius-kbd` chip from `lg` |
| report · theme         | `ReportButton` · `ThemeToggle`                       | same icon-button grammar                                                      | `--height-control` square, `--radius-control`                                       |
| bell                   | `NotificationBell` → `Popover`                       | badge `--el-accent` on `--el-accent-text`, ringed in `--el-page-bg`           | `--height-control` square, `--radius-control`; badge `--radius-badge`               |
| avatar                 | `UserMenu` → `Popover`                               | `--el-text` fill, `--el-text-inverted` initial                                | `--height-control` square, `rounded-full` (genuinely circular)                      |
| Plan-with-AI pill      | `PlanWithAILauncher`                                 | palette-derived `color-mix` over `--el-accent` / `--el-highlight` — unchanged | `--radius-badge`, `--height-btn-md`, `--spacing-btn-x`                              |
| build-in-public slot   | `BuildInPublicButton` / `BuildingInPublicHeaderLink` | `--el-build-bg` fill, `--el-build-text` ink, `--el-build-glyph` megaphone     | `--radius-badge`, `--spacing-chip-x/y`                                              |
| drawer + utility strip | `SidebarDrawer` (Radix Dialog)                       | `--el-sidebar-bg`, `--el-sidebar-border`                                      | `h-14` strip mirroring the drawer header, `--shadow-modal` panel                    |

**One shape correction the code card should carry with the rest.** The controls that today hard-code
`h-9` / `w-9` / `p-(--spacing-icon-btn)` for their own box (`CommandPaletteTrigger`,
`CreateIssueButton`, `ThemeToggle`, `UserMenu`, `ReportButton`, `NotificationBell`) take
`--height-control` instead. That is what makes all four slots one square, what removes the 28/36/38
mixture, and what lets the budget survive a `data-style` swap — a raw `h-9` does not reshape.

### What this design overrides

Three areas made narrow-width claims in passing, while designing something else. Two of them were
never built, and one is contradicted by the render.

1. **`design/ai-chat/design-notes.md:458`** — the pill is _"present on every screen, never covering
   content"_. **Retracted below `md`.** Measured: at 375px the pill's box is `x 24–76` and the
   hamburger's is `x 16–52`; it covers 28 of the hamburger's 36px. Replaced by: the pill is a
   `md`-and-up control, and below `md` the `PlanWithAIFab` orb is the door. The _intent_ of the
   sentence — one universal entrance, always reachable (`notes.html` #83 / #89) — is preserved
   exactly, because the orb ships and is mounted under the same gate.
2. **`design/ai-chat/design-notes.md:786` and `:1015`** — the eight-control order
   `[Plan with AI] [Build in public] [+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]`.
   **Kept unchanged from `md` up**, where all eight are present; superseded below `md` by the
   four-slot set, which preserves the relative order of the controls that remain.
3. **`design/notifications/design-notes.md:44-47`** — the bell _"inside the off-canvas mobile
   `SidebarDrawer` … renders icon-only"_. **Verified unbuilt** — `components/ui/SidebarDrawer.tsx` on
   `origin/main` imports no notification component, so this was prior art, not a fact (`notes.html`
   #45: do not read "shipped" and believe it). **Overruled for the bell**, which stays in the bar: a
   badge inside a closed drawer conveys nothing, and the bell is the one control with no second door.
   The claim's _form_ is adopted and generalised — displaced shell controls do render icon-only inside
   the drawer, in the utility strip, which is now where that promise lives.
4. **`design/public-projects/design-notes.md:596-606`** — the single stateful slot, _"exactly one,
   never both, never empty"_. **Kept**, and extended: the slot is now stateful in two dimensions,
   state × breakpoint. Below `md` both of its states live in the drawer strip. This section also
   records the measured asymmetry that design did not know it had created (finding 2 above).

### How the render was produced

The asset is generated, not hand-drawn, so it cannot drift from the app:

1. The real `TopNav` is rendered through the repo's own vitest + RTL setup inside `CommandPaletteProvider`
   / `CreateIssueProvider` / `ProjectAccessProvider` / `ReportProvider` / `ThemeProvider` and a
   `NextIntlClientProvider` seeded from `messages/en.json`, in three prop states (private+AI,
   public+AI, self-hosted floor); `container.innerHTML` is dumped per state. The shipped
   `SidebarDrawer` + `SidebarNav variant="drawer"` are dumped the same way.
2. Tailwind compiles `app/globals.css`'s layers over that markup, so the mock's stylesheet is the
   build's own output rather than a retyped token block.
3. The target bars in Panels C–E are those same shipped elements with only the responsive prefixes
   this design changes — so the markup in the asset is the markup the code card ships.

Two harness artefacts, both corrected in the asset and named here so nobody reads them as design:
happy-dom drops a `background-image` whose value is a `linear-gradient()` over `color-mix()`, so the
pill's fill and its shimmer are restored verbatim from `PlanWithAILauncher.tsx`; and because every
frame shares one document, the compiled `@media (width >= …)` blocks are re-emitted scoped to
`[data-vw="…"]` so each frame resolves its own width. Both are properties of the board, not of the app.

---

## The navigation-pending grammar (MOTIR-3431 · RE-MOUNTED by MOTIR-3492)

**What the authed content area shows between the click and the arrival.** The area had no drawing for
this state at all — `git grep -in 'loading\|skeleton\|pending\|spinner\|busy' origin/main -- design/shell/design-notes.md`
returned nothing at `dacf711b` — so every surface that has needed one so far invented its own, and
four different pulse compositions now live in four `_components` folders. This section is the one
grammar all of them answer to.

**Asset ·** `navigation-pending.mock.html` / `navigation-pending.png`. **Cards ·** MOTIR-3431 drew it;
MOTIR-3492 re-drew it against the constraint below. The code cards that built the first revision
(MOTIR-3433, MOTIR-3435) were **reverted**; MOTIR-3434 shipped and is untouched by this revision.

### ⚠️ THE CONSTRAINT THIS REVISION EXISTS FOR — a `loading.tsx` cannot sit above a page that 404s

**A `loading.tsx` fallback can render as soon as its ancestor layouts resolve, which is BEFORE the
page function runs. That flushes the response head and fixes the HTTP status at 200, so a
`notFound()` reached later renders the not-found BODY under a 200 and the 404 is gone.** **11 of the
58 `app/(authed)` pages call `notFound()`**, three of those assertions are tenant-isolation
contracts, and `/items/[key]`'s own source calls its 404 a _"no existence leak"_ guarantee. A group
boundary breaks all 11 at once.

Established by A/B with the boundary as the only variable, not by argument — the table is in
`motir-core/CLAUDE.md` § _A `loading.tsx` may NOT sit above a route that decides existence_, which is
the prose home of the rule; `tests/navigation/loading-boundary-guard.test.ts` is the guard. **Hoisting
the `notFound()` into a `layout.tsx` above the page does not help and was built and measured:** a
layout is an ANCESTOR of the boundary, so resolving it is precisely what RELEASES the fallback.

The first revision of this section said _"one `app/(authed)/loading.tsx` is the floor for all 58
pages"_. **That floor cannot exist.** Everything below is what survives, and where the frame goes
instead.

### THE WAIT HAS THREE WINDOWS, AND THE MISTAKE WAS BELIEVING IT HAD ONE

The frame was not the error. The error was giving windows 1 and 2 the same boundary, when only one of
them is the page's to speak for.

| #     | window         | from → to                                 | who can speak                                                                                                            | instrument                                                                                      |
| ----- | -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **1** | the GATE       | the click → the destination's first flush | only the SHELL, which is already mounted. On a HARD navigation nobody can, and that is not a defect — no page exists yet | the shell's pending mark (client-only, below)                                                   |
| **2** | the FRAME      | the first flush → the first content       | the destination page itself                                                                                              | an in-page `<Suspense>` placed AFTER the page's gate                                            |
| **3** | the LATE STACK | the first content → settled               | the page                                                                                                                 | the page's own allocation — `design/work-items/` § _The item page at ARRIVAL_ is the worked one |

**Window 1 is the one a route boundary was buying, and it is the one that cannot be bought that way.**
A gate is by definition the reads that decide whether this reader may see this page at all, so nothing
may be flushed until it has run. What a route boundary offered was to flush anyway — which is exactly
the defect.

**So the design's real instruction is to SHRINK window 1**, and it is not a slogan: a gate is
`getSession` → the active project → the existence read → the permission read, and **anything else in
front of the boundary is a read that could have been behind it**. `app/(authed)/items/[key]/page.tsx`
is the shipped demonstration — twenty-nine serial awaits cut to that gate plus one concurrent group
(MOTIR-3435's surviving half).

### WINDOW 1 — THE SHELL'S PENDING MARK, and why it is a MARK and not a frame

**On a soft navigation the shell is already mounted, so a CLIENT affordance renders with no server
boundary anywhere — and therefore cannot touch a status.** On a document request it does not render at
all: the shell is being produced by the server for the first time and there is no pending navigation
to have. That asymmetry is the whole reason this instrument is safe where a `loading.tsx` is not.

**It is a MARK on the thing the reader clicked, not a skeleton.** The shell does not know the
destination's shape. A skeleton drawn by the shell would be a guess that the page's own frame then
replaces — two frames for one navigation, which is the flicker the reveal delay exists to remove,
wearing a third costume.

|                   | the decision                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **what**          | the clicked `<Link>` marks itself pending — the rail item, the breadcrumb, the table row that navigates                                                                                                                                   |
| **how**           | `useLinkStatus()` from `next/link` (verified exported at `next@16.2.6`), read inside ONE wrapper the shell's nav items and navigating rows compose, never at each call site                                                               |
| **the treatment** | the rail item's OWN hover treatment, HELD — `--el-sidebar-item-bg-hover` behind it and `--el-text` ink, which is what the item already paints under a pointer. No spinner, no new hue, no size change: a mark that resizes moves the rail |
| **when**          | the same `nav-pending-reveal` keyframe and the same 120 ms delay, REFERENCED, never re-declared                                                                                                                                           |
| **a11y**          | `aria-busy="true"` on the marked link; the destination's own frame announces the region, so the mark does not also announce a live region                                                                                                 |

**What it deliberately does NOT cover, said plainly rather than left to be discovered:**

- **A typed URL, a reload, an emailed link.** A hard navigation has no mounted shell. Nothing can speak
  in window 1 for these, at any cost, and the reader's first feedback is window 2's frame. This is
  what makes shrinking the gate the substantive work rather than the frame.
- **A programmatic `router.push`** — `/items`' tree ↔ list, the plans list's status tabs, the item
  page's activity tabs. `useLinkStatus` reads a `<Link>`, and these are not links. Their pending state
  is `useTransition()`'s `isPending` at the call site, wrapped as `startTransition(() => router.push(…))`,
  feeding the SAME mark. Three call sites, named here so the next author does not invent a fourth
  mechanism for them.
- **A `shallowPush` switch** — nothing at all, and that is THE SWITCH RULE below, unchanged.

### WINDOW 2 — THE FRAME, MOUNTED IN THE PAGE

**The drawing is unchanged. Only the mount point moved.** The wrapper, the header block, the toolbar
row, the content region and the whole no-shift mapping below are the first revision's, verbatim —
they were never what was falsified.

The shape a page takes:

```tsx
// the GATE — awaited, with NO boundary above or around it. The status is
// decided here, so nothing may be flushed until it has run.
const session = await getSession();
if (!session) redirect('/sign-in');
const ctx = await getActiveProject();
const item = await …;            // may notFound() — the 404 is still a 404
const held = await …;            // may decide the affordances

// the FRAME — the first flush carries it, and the status is already committed
return (
  <Suspense fallback={<PageSkeleton … />}>
    <Body … />                    {/* every non-gate read lives in here */}
  </Suspense>
);
```

**Why this is safe and a `loading.tsx` is not, in one sentence:** the boundary is BELOW the gate
rather than above it, so the flush it releases happens after the status is settled instead of before.

**`/items` already ships exactly this** — its header and `[Filter] · [Tree ▾] · [+ New]` toolbar render
from the gate, and only the table sits behind `<Suspense fallback={<IssueTreeSkeleton/>}>`. Under the
first revision `/items` was the story's stated EXCEPTION, the one page a sweep would damage. **Under
this revision it is the worked example.** That inversion is the clearest single test of whether the
new grammar is the right one.

### WHICH SURFACES EARN A FRAME — the rule, replacing _what a nearer boundary owes this one_

1. **Every page may have one; no page inherits one.** There is no group frame and there cannot be one.
   A page without a frame is a page that has not been given one — not a page that opted out.
2. **A frame only ever covers a region that has NOTHING to show yet.** Whatever the gate alone can
   paint — a header, a static toolbar, a tab strip — is painted, and the boundary goes below it. A
   frame drawn over a control the reader can already click is a page made worse by being swept.
3. **Its SHAPE is chosen from three, in this order.** The page's OWN body shape where the page has one
   worth standing in for; the FAMILY shape where a set of routes share a body — the 31 `settings/*`
   routes' rail-and-pane is the one such family, and it is `design/settings/`'s to draw; the GENERIC
   block frame (Panel B) otherwise.
4. **The shared parts still live in ONE primitive.** `PageSkeleton` owns the wrapper, the header block
   and the reveal; a page passes its body in. A frame that COPIES those three instead of composing
   them is the drift that put `IssueTreeSkeleton` three columns and 272 px behind the table it stands
   in for, for eighty days, with its own comment promising it was in sync (MOTIR-3452).
5. **No `loading.tsx` is added anywhere under `app/(authed)`.** It stays legal above a subtree where no
   page decides existence — 47 of the 58 qualify — and this design still declines it, for the locator
   cost below. **One mechanism, not two.** (`app/(planning)/loading.tsx` and the two under
   `settings/project/` predate this and are out of scope; the guard rules on the shape, not on this
   preference.)

### ⚠️ THE THIRD INSTRUMENT — a ROUTE GROUP, weighed and declined FOR THIS GROUP (MOTIR-3491, merged 2026-08-26 while this asset was in review)

**This asset was drawn on the premise that a decider-containing subtree has two options: drop the
boundary, or move the frame in-page. There is a third, it shipped on `main` mid-review, and naming it
is owed** — a design that presents two options where the codebase has three is wrong in the way a
reader cannot detect.

**A route group adds no URL segment and owns its own boundary.** So the fix is not always to remove a
boundary from above a decider — it can be to move the SAFE routes and the `loading.tsx` together into
a `(group)`, leaving the deciding sibling outside it and above the boundary rather than beneath it.
`/explore` keeps its frame from `app/(public)/explore/(square)/loading.tsx` while
`explore/topic/[slug]` keeps its 404, verified in the built loader trees: `(square)/page.js` carries
the loading chunk and `topic/[slug]/page.js` carries none. `motir-core/CLAUDE.md` § _What to use
instead_ carries it as a fourth ✅.

**It changes rule 5's REASON and not rule 5.** The rule was never _a route boundary is impossible
here_; it is _a route boundary is declined here_. Three things decide it, and only the third is about
this group specifically:

|                                           |                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **it is still a ROUTE boundary**          | so it carries the locator cost below **in full** — React retains the previous route's subtree either way. A group scopes which routes are beneath a boundary; it does not change what a boundary does to the DOM                                                                                                                                            |
| **it does not reach window 1**            | the gate still runs before anything is flushed, and a group does not change when. Only the shell's mark reaches that window                                                                                                                                                                                                                                 |
| **the shape of THIS group is against it** | `/explore` is two routes and one boundary. `app/(authed)` is **58 routes with 11 deciders scattered across `settings/`, `items/`, `plans/`, `sprints/`, `dashboard/` and `direction/`** — six separate group carve-outs, each moving pages between directories, to buy a frame an in-page `<Suspense>` gives one page at a time with no tree surgery at all |

**So: correct instrument, wrong group — and that is a judgement to re-take, not a rule to inherit.**
A future authed subtree that is genuinely uniform — several routes, none deciding, one frame worth
sharing, no spec asserting unscoped against them — is the `/explore` shape, and the group is right
there. What must not happen is a carve-out justified by _the design says no `loading.tsx`_ when the
real reasons are the two rows above.

**The 24 heavy surfaces MOTIR-3440 sweeps, by whether a route boundary was ever available to them** —
measured at `origin/main` `4fd55464` with
`grep -rl 'notFound()' 'app/(authed)' --include=page.tsx`:

| family                       | surfaces                                                                                                                                                                                                                    | deciders among them                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| project settings (10)        | `settings/project`, and under it the board, workflow, automation, repositories, AI-planning and lesson-list panes, `settings/project/ai-planning/lessons/[lessonId]`, `settings/project/roles/[roleKey]` and its edit route | **3** — the lesson, the role, the role's edit         |
| workspace + organization (4) | `settings/workspace/jobs` · `settings/workspace/gitlab` · `settings/organization` · `settings/organization/billing`                                                                                                         | **1** — billing, the self-host 404 the A/B was run on |
| work-item lists (2)          | `items/archived` · `items/[key]/edit`                                                                                                                                                                                       | **1** — the edit route                                |
| canvases (4)                 | `roadmap` · `plans` · `plans/[id]` · `boards`                                                                                                                                                                               | **1** — `plans/[id]`                                  |
| its own card (1)             | `code-health`                                                                                                                                                                                                               | 0                                                     |
| reports + one-shots (3)      | `reports/burndown` · `sprints/[id]/report` · `invite/accept`                                                                                                                                                                | **1** — the sprint report                             |
| the non-regression (1)       | `items`                                                                                                                                                                                                                     | 0 — and it already streams                            |

**Seven of the 24, and five of the eleven deciders sit under `settings/`** — so the settings family,
the one place a shared boundary looked most obviously right, is the one place it is most obviously
wrong. The family's shared frame survives as a shared COMPONENT that all 31 routes render in-page; it
does not survive as `app/(authed)/settings/loading.tsx`.

### THE LOCATOR COST — decided, and the decision is not to incur it

**The cost belongs to the ROUTE boundary, not to the frame.** A route-level fallback makes React
retain the previous route's subtree mounted-and-hidden while the new one streams, so both are in the
DOM; Playwright resolves locators before filtering on visibility, so an unscoped `getByText` /
`getByTestId` / `getByLabel` matches both and fails strict mode. One group boundary turned **30
assertions across 17 spec files** red at once, and exactly zero of the 30 used `getByRole`, which is
immune because the accessibility tree excludes the hidden copy.

**An in-page `<Suspense>` renders INSIDE the destination page, so the previous route is already gone
and there is one subtree in the DOM.** Measured on the same file rather than argued:

| `tests/e2e/issue-detail-flow.spec.ts`                                   | result             |
| ----------------------------------------------------------------------- | ------------------ |
| with the `(authed)` group boundary                                      | **8 of 16 failed** |
| boundary removed, nothing else changed                                  | **16 passed**      |
| with the two in-page boundaries `/items/[key]` ships today (MOTIR-3436) | **16 passed**      |

and that file still contains **23** unscoped `page.getByText` / `getByTestId` / `getByLabel` calls
against 76 `getByRole` ones (counted at `origin/main` `4fd55464`). It is the spec most exposed to the
collision and it is green.

**So the decision is (b) of the two MOTIR-3492 offered — scope the boundaries, not the assertions.**
No spec is rewritten by this design and none needs to be; scoping the 30 to `getByRole` stays good
practice on its own merits and is a prerequisite of nothing here. **The standing rule this leaves:
a route-level boundary is a suite-wide change and an in-page one is a local change.** If a route
boundary is ever reintroduced, the 30 come back with it, and that is the number to weigh at the
moment of reintroducing it.

### THE REVEAL DELAY — 120 ms

**Unchanged, and it now governs both reveals** — the shell's mark in window 1 and the page's frame in
window 2. One declaration, referenced twice; two reveals at two times is the flicker this design
exists to remove.

```css
@keyframes nav-pending-reveal {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.nav-pending {
  animation: nav-pending-reveal 90ms ease-out 120ms both;
}
```

**Why the affordance is MOUNTED at 0 and not at 120.** Once the reader has committed to a
destination, the previous surface is lying. Mounting immediately is what makes the pending state the
thing on screen; the delay governs only whether the reader is shown it.

**Why 120, argued from the two states a reader can be in — the only two there are:**

| the window resolves                                                              | what the reader sees                                                                        | why the number holds                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **in under 120 ms** — a cached segment, an empty settings pane                   | the previous surface, then the destination. **Nothing pending is ever visible.** One paint. | 0.1 s is the classical ceiling for a response that reads as _instantaneous_. Inside it the navigation has already succeeded, and a state placed there is an interruption the reader has to parse and discard. 120 ms is that ceiling plus one 60 Hz frame of slack, so a route landing one frame late is still treated as instant. |
| **in longer than 120 ms** — Work Items, the item page, anything with a real read | the mark, then the frame, before their eye has finished travelling                          | the navigation has ALREADY failed to feel instantaneous, so a pending state is not an interruption — it is the only evidence the click landed. A saccade to the content region lands around 150–200 ms after the click, so a reveal begun at 120 ms is in place before the reader looks at it and they never see it arrive.        |

**It is an animation, not a timer, and that is load-bearing.** No `useEffect`, no `setTimeout`, no
client state, nothing to clean up when a navigation is abandoned: the element is removed and the
animation goes with it. A window that closes in 40 ms unmounts its affordance 80 ms before it would
have become visible, and no code had to decide that.

**Under `prefers-reduced-motion: reduce` the delay stays and the motion goes** — the reveal becomes a
step at 120 ms with no fade, and the pulse stops, leaving static blocks. The delay is not an animation
preference: it is what stops a fast route showing a state it does not need, and a reader who asked for
less motion asked for fewer flashes, not more.

### THE NO-SHIFT CLAIM — heights and gaps, never widths

**A layout shift on settle is VERTICAL.** The frame and the arriving page both fill `<main>`'s width,
so a placeholder bar being a different _width_ from the title it stands in for moves nothing — a
block-level line box occupies its whole line either way. What moves the page is a block whose
**height**, or the **gap above it**, differs from the region that replaces it. So the frame matches
heights and gaps exactly and takes its widths from what reads as a page.

| #   | block          | its box                                                                 | the region it becomes                                   | why the pair cannot shift                                                                                                                                                                                        |
| --- | -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Title          | `h-8` (32px) · `w-56`                                                   | the page's `<h1>` — `font-serif text-2xl font-semibold` | `text-2xl` is 1.5rem on a 2rem line box = **32px**. Same box, so the row below starts at the same y.                                                                                                             |
| 2   | Subtitle       | `h-4` (16px) · `w-80`                                                   | the optional `<p>` under the heading                    | present on Roadmap, Reports and every settings pane; **absent** on Work Items. See the compromise below.                                                                                                         |
| 3   | Toolbar        | `h-(--height-control)` · three chips                                    | the page's control row                                  | the real controls are all `--height-control`, so the frame inherits the height rather than restating it — and flips with the style axis for the same reason.                                                     |
| 4   | Content        | `rounded-(--radius-card)` bordered region · 40px header + 8 × 40px rows | the table, list or board the page renders               | 40px is the shipped table's own row height. Eight rows is a screenful and is deliberately not a count of anything.                                                                                               |
| —   | the column gap | `gap-6` (24px) on the outer flex column                                 | the `gap-6` every authed page already uses              | Work Items, Roadmap and both shipped settings `loading.tsx` files all open `flex flex-col gap-6`. The frame **is** that wrapper, so the vertical rhythm is not a copy of the pages — it is the same declaration. |

**At what widths.** All of it, and that is the point of measuring vertically. The frame adds **no
horizontal gutter of its own** — `app/(authed)/layout.tsx` already wraps `{children}` in
`px-4 pt-6 pb-(--shell-bottom-clearance) sm:px-6 lg:px-8`, and the frame renders inside that wrapper
exactly as a page does. A frame that re-applied the gutter would double it at every breakpoint. The
blocks' widths are `w-56` / `w-80` / fixed chip widths, which never reach the column's edge at any
authed width, so nothing reflows between breakpoints and there is no width at which the claim is
weaker.

**The subtitle block is the one honest compromise, and it is stated rather than hidden.** A frame that
draws a subtitle settles **20px UP** on a page that has none; a frame that omits it settles 20px DOWN
on the majority that do. Drawing it is the better half — an upward settle pulls content toward the
reader's eye rather than away from it, and the pages carrying no subtitle (Work Items, Boards) are
also the fast ones, which under the reveal delay usually never show the frame at all. **A route that
both carries no subtitle AND reads slowly should pass its own body to `PageSkeleton` rather than take
the generic one** — which under this revision is a prop, not a second boundary.

### THE SWITCH RULE — a client-only view switch shows NO pending state

**Unchanged by this revision, and it is the one part of the first one that shipped.** When a toggle's
target body needs no new server data, there is nothing to wait for. Draw no spinner, disable no
segment, show no skeleton, dim nothing. The body is simply there, in the same frame as the click. A
pending affordance on such a switch is a **defect**, not a courtesy: it manufactures a wait the reader
would not otherwise have had, and it is the complaint this story was reported for, reintroduced as a
feature.

**The three call sites it governs** — drawn at rest in both positions in Panel E, re-pointed at the
lifted helper by MOTIR-3434, and guarded by `tests/navigation/loading-boundary-guard.test.ts`:

| call site                                             | param                    | why the server has nothing to say                                                                                            |
| ----------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `components/planning/PlanDetail.tsx`                  | `?view=list\|canvas`     | both bodies render from the `review` the island already holds in `useState`                                                  |
| `app/(authed)/items/[key]/_components/ChildPanel.tsx` | `?children=list\|graph`  | the list body IS the already-rendered `children` prop; the graph mounts a client canvas that fetches its own level           |
| `components/planning/RoadmapView.tsx`                 | `?scope=project\|sprint` | the canvas refetches on its `key={scope}` remount — the file's own comment already says the navigation is not what drives it |

**Three switches are NOT governed by it and keep their `router.push`:** Work Items' tree ↔ list, the
plans list's status tabs, and the item page's activity tabs. Each changes what the server must fetch,
so each is a real navigation — and under this revision each is entitled to the shell's MARK (via
`startTransition`, above) and to its destination's own frame. **The discriminator is not the control**
— all six are the same `Segmented` — **it is whether the target body needs data the browser does not
have.**

### Primitives and tokens

| element                     | primitive / token                                                                         | note                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the frame's wrapper         | `flex flex-col gap-6`                                                                     | the same wrapper an authed page opens with; no gutter — the layout's `{children}` wrapper already pays it                                                                                                                                                                                                                                                            |
| every placeholder block     | `bg-(--el-muted)` fill · `rounded-(--radius-control)`                                     | the shipped pulse vocabulary — `IssueTreeSkeleton`, `BacklogSkeleton`, `BoardSkeleton` and `PlanningWorkspaceSkeleton`. **This design does not redraw any of them**; `components/settings/SettingsPaneFrame.tsx` is the closest existing composition and is the reference (it carries what the two settings `loading.tsx` files drew before MOTIR-3558 deleted them) |
| the pulse                   | `animate-pulse` on the inner wrapper                                                      | one animation for the whole frame, so the blocks pulse in phase rather than as a field of independent flickers                                                                                                                                                                                                                                                       |
| the content region's chrome | `rounded-(--radius-card)` · `border-(--el-border)` · header band `bg-(--el-surface-soft)` | mirrors the shipped table container, which is what makes block 4 a stand-in rather than a rectangle                                                                                                                                                                                                                                                                  |
| the toolbar chips           | `h-(--height-control)`                                                                    | the height every real toolbar control already takes                                                                                                                                                                                                                                                                                                                  |
| status-pill placeholders    | `rounded-full`                                                                            | genuinely circular ends; the shape rule's carve-out, matching the shipped `Pill`                                                                                                                                                                                                                                                                                     |
| the shell's pending mark    | `--el-sidebar-item-bg-hover` fill · `--el-text` ink                                       | the rail item's own hover pair, HELD. It exists in the build only as a `hover:` variant, so the treatment is a state the component already owns rather than a new one — no new hue, and no size change, because a mark that resizes moves the rail                                                                                                                   |
| the announced state         | `aria-busy="true"` on the frame and on the marked link; blocks are decorative             | the reader of a screen reader is told the region is busy once, not eight times                                                                                                                                                                                                                                                                                       |
| the reveal                  | `nav-pending-reveal` keyframe, `120ms` delay, `90ms ease-out`, `both`                     | the one declaration; window 1 and window 2 both reference it                                                                                                                                                                                                                                                                                                         |

**No Tier-0 anything.** No `--color-*`, no `rounded-md`/`p-2`/`h-9`, no invented hue. The board's own
chrome takes `--el-text-secondary` for annotation ink rather than `--el-text-muted`, which fails AA on
`--el-surface-soft` and on `--el-muted` — the two surfaces this board's tables and rule blocks paint
on (`docs/decisions/design-board-chrome-aa.md`).

### The access path

**This state has no menu entry: its entrance is every navigation in the group.** That is why the asset
opens with a TRANSITION rather than a screen — Panel A draws the surface being left, the window in
which deliberately nothing happens, the gate window with the shell's mark on it, the page's own frame
after the flush, and the arrival, with the shell held identical throughout. A single still of a
skeleton could not show the reveal delay, the three windows or the no-shift claim at all; the
sequence is what makes them readable.

### The design-allocation sweep — what this asset GIVES and TAKES

| card                                                   | GIVES / TAKES | what                                                                                                                                                                                                             |
| ------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-3434** — `shallowUrl` and the three call sites | **GIVES**     | the switch rule, unchanged from the first revision and already shipped. This revision takes nothing back from it                                                                                                 |
| **MOTIR-3440** — the remaining-surfaces story          | **GIVES**     | the three windows, the in-page mount point, the earn-a-frame rule, the per-family decider count, and the locator decision. **TAKES** its "settings gets a frame of its own" premise, which named a `loading.tsx` |
| **MOTIR-3441** — the settings family's arrival frame   | **GIVES**     | that the family shape survives as a shared COMPONENT rendered in-page by all 31 routes, and that five of the eleven deciders are inside that family                                                              |
| **MOTIR-3442** — the earn-your-own-frame rule          | **GIVES**     | the rule in full, above. **TAKES** its "instead of the group's" framing: there is no group's frame to be an alternative to                                                                                       |
| **MOTIR-3492** — this card                             | **TAKES**     | everything the first revision said about a route-group boundary                                                                                                                                                  |
| **MOTIR-3491** — the `/explore` 404 fix                | **TAKES**     | the two-option framing. It shipped the ROUTE-GROUP instrument mid-review and proved it on a live surface, so rule 5 now reads _declined for this group_ with its reasons, rather than _there is no other way_    |

### ⚠️ What this asset SPECIFIES that no card owns

Named here rather than left to be inferred, because all three are things the first revision's code
cards built and the revert removed. **This asset does not create them, and it is not a plan:**

1. **`PageSkeleton`** — the shared primitive owning the wrapper, header block and reveal. Built by
   MOTIR-3433, reverted with it. Every in-page frame composes it, so nothing above can be built first.
2. **The shell's pending mark** (window 1) — the `useLinkStatus` wrapper and its adoption by the rail.
   MOTIR-3433 spent this window on the group boundary instead, so it has never been built.
3. **`/items/[key]`'s own frame** (window 2) — MOTIR-3435's boundary half was reverted, so the page
   today flushes nothing until its tier-2 group resolves. Its concurrency half shipped and stands.

### What this design overrides

**Its own first revision, MOTIR-3431's, and only in the mount point.** (And it was itself amended
once before merging, by MOTIR-3491 landing on `main` mid-review — the third-instrument section above.
The amendment is recorded there rather than folded in silently, because a reader who meets a route
group in this codebase should find the moment this asset learned about it.) The frame's composition, the
reveal delay, the no-shift mapping and the switch rule are carried forward verbatim; what is withdrawn
is the route-group boundary that mounted them, the sentence _"one `app/(authed)/loading.tsx` is the
floor for all 58 pages"_, and the nearer-boundary table that read `the group frame` against
`a route-shaped frame`. Two adjacent facts it still does **not** change, named so a reader does not
infer them:

- **`app/(planning)/loading.tsx` stays as it is** (MOTIR-2069), and the two under `settings/project/`
  stay as they are. They sit above no page that calls `notFound()`, so the rule does not reach them;
  rule 5 above is a preference for new work, not a sweep of existing files.
- **The four existing `_components` skeletons stay as they are.** They are `<Suspense>` fallbacks
  INSIDE a page — which is now the sanctioned shape rather than the tolerated one — and this design
  supplies the vocabulary they already speak and takes nothing from them.

### How the render was produced

The asset is generated, not hand-drawn, so it cannot drift from the app:

1. The top bar in every frame is the real `app/(authed)/_components/TopNav.tsx`, taken from this area's
   own `context-row.mock.html` Panel A — captioned there as _"what ships today, rendered"_.
2. The rail is the real `SidebarNav variant="rail"`, and the settled Work Items page is the real
   `IssueTreeStaticTable` over the real `buildIssueColumns` registry — both dumped from the repo's own
   vitest + RTL setup with the real `messages/en.json`. The three switches are the real `Segmented`, in
   the exact option sets its three call sites pass it.
3. Tailwind compiles `app/globals.css`'s layers over that markup, so the mock's stylesheet is the
   build's own output rather than a retyped token block.
4. **This revision re-uses those renders unchanged and edits only what the constraint falsified** —
   the sequence's captions and mechanism, the rule panel, and the two panels added for the shell mark
   and the locator decision. Re-generating the shipped-component regions would have changed pixels
   that no finding touched, and made the diff unreadable for the reviewer who has to check the part
   that did change. The PNG is re-exported with `node scripts/render-design-mock.mjs`.

The only markup here that is **not** already shipped is the pending frame, the shell's mark, and the
keyframe beside them — which is what this card exists to decide.

Two board artefacts, named here so nobody reads them as design: the shell stages are held at a fixed
**560px** so the sequence reads as one, where the app's shell is `h-dvh`; and the frames that show a
revealed state force the animation's end state, because a board is a still and a time-based state has
to be frozen at the moment it is being drawn.

---

## The context row — `org › workspace › project`, the rail head, and the brand tile (MOTIR-2555)

The code changes are **MOTIR-2556** (the move) and **MOTIR-2557** (the brand tile). This asset —
`context-row.mock.html` / `context-row.png` — decides what they build, and it AMENDS the control
budget above: that section decided the RIGHT cluster, this one decides the LEFT.

### What the ask was, and what the measurement made of it

Put the organization, the workspace and the project in one row, most-specific last; keep the
workspace tier hidden when the org has only one; give the brand mark a filled, rounded box with the
glyph in the primary colour.

The first two thirds of that already exist. `ShellTierNav.tsx` renders `OrgControl` always and
`WorkspaceSwitcher` only when `workspaces.length >= 2` — _"below that threshold the middle tier is
implicit and never shown"_ — so `org › project` is not a new rule, it is the rule the middle tier
already follows with a third tier appended behind it. What is genuinely new is that **the row has no
room**, and that is what this design is mostly about.

### The measurement — and a finding the budget above did not have

Every number below was measured, not estimated: the real `OrgControl`, `WorkspaceSwitcher`,
`ProjectSwitcher`, `SidebarHeader`, `ShellTierNav` and `TopNav` were rendered through the repo's own
vitest + RTL harness with the real `messages/en.json`, then laid out in Chromium against the build's
own compiled Tailwind output. `room` is `viewport − gutters − right cluster − the left cluster's
NATURAL (min-content) width`; negative means the elastic tier truncates. `ovf` is real horizontal
overflow and must be zero.

| viewport | ships today: left nat. · right · room · **ovf** | this design: left nat. · right · room · **ovf** |
| -------- | ----------------------------------------------- | ----------------------------------------------- |
| 320px    | 351 · 168 · −231 · **47**                       | 166 · 168 · −46 · **0**                         |
| 375px    | 351 · 168 · −176 · **0**                        | 166 · 168 · +9 · **0**                          |
| 768px    | 364 · 468 · −112 · **0**                        | 259 · 468 · −7 · **0**                          |
| 1024px   | 364 · 733 · −121 · **0**                        | 259 · 733 · −16 · **0**                         |
| 1280px   | 364 · 733 · +135 · **0**                        | 486 · 733 · +13 · **0**                         |

Measured in the WIDEST right-cluster state — a public project with AI configured — because that is
the state that sets the budget.

> **⚠️ FINDING — the 68px tier-nav floor was never reachable, and the shipped bar STILL overflows at
> 320px.** The budget above computes the below-`md` slot count from
> `320 − 32 − 36 − 8 − 8 − 68 = 168px`, reserving **68px** for the tier nav. The two shipped tiers
> cannot compress below **112px**: `OrgControl` and `WorkspaceSwitcher` are `inline-flex` ghost
> buttons whose avatar, chevron and padding are all `flex-none`. So at 320px the row needs 348px of
> a 320px viewport and **overflows by 47px** — on `main`, today, after MOTIR-2373. That is Panel A's
> first frame. The arithmetic was right about the right cluster and wrong about the floor, because a
> floor is a claim about what an element can compress TO, and nothing had measured it. This design
> closes it as a side effect; the finding belongs to this pass and is recorded here rather than
> quietly fixed.

### The measurement, re-taken without the marks (MOTIR-2674, 2026-08-11)

The table above was measured with BOTH marks present. `docs/decisions/entity-marks.md` removes the
org's mark entirely and makes the project's optional, so every number in the `this design` column
was re-taken. **The harness is committed as `scripts/measure-context-row.mjs` and is re-runnable**
(`node scripts/measure-context-row.mjs`): it loads THIS asset in Chromium — so it measures the real
component markup against the build's own CSS — and applies each variant as a DOM mutation. Basis:
`scrollWidth` of the bar's left cluster, and the row's overflow against the frame. That basis is
stated because it is not the min-content basis the older table used; the two agree at `xl` (486px)
and diverge at `md`, where min-content reports the truncated width and this reports the laid-out one.

| band (Panel B frame) | today: marks present | marks REMOVED | **org NAME from `md`** (shipped) |
| -------------------- | -------------------- | ------------- | -------------------------------- |
| 320px                | 120px                | 110px         | 110px                            |
| 375px                | 165px                | 136px         | 136px                            |
| 768px (`md`)         | 242px                | 209px         | **244px**                        |
| 1024px (`lg`)        | 233px                | 209px         | **240px**                        |
| 1280px (`xl`)        | 486px                | 428px         | **428px**                        |

> **⚠️ Where the baseline lives now.** The `today: marks present` column was measured against
> **Panel B as it stood before this pass corrected it**. Panel B, C and E have since been amended to
> draw the target (no org mark, no preset chip, org name from `md`) — because an asset that shows the
> old target beside the new one cannot tell a reader which is current. So re-running the harness today
> compares against **Panel A**, which keeps the ships-today row on purpose; the with-marks numbers
> above are reproducible from Panel A and from this file's history, not from Panel B.

Row overflow is **0 at every band, in every variant** — the ladder holds with the marks gone.

> **A second finding, on the SHIPPED bar (Panel A).** Re-measured here at **49px** of overflow at
> 320px, against the 47px recorded above; the 2px is the basis difference just described, not a
> regression. Of that, **28px is the two marks** (351px → 323px with them removed) — so the marks
> were paying more than a quarter of the overflow that finding is about. Removing them does not
> close it on the OLD bar (21px remains); the below-`md` rule in Panel B is still what closes it.

### The ladder — the design

One elastic row, three things that want it. The answer is a LADDER, and it follows the breadcrumb
convention every mature tool uses: **the most specific tier never leaves; ancestors collapse from
the left.**

| band                 | the bar's path                                           | left cluster, measured at the band's narrowest |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `< md` (0–767px)     | **project only** — hamburger + the project tier          | 110px, 0 overflow at 320                       |
| `md`–`xl` (768–1279) | **`org › project`**, the org as its **NAME** (see below) | 244px at 768 · 240px at 1024, 0 overflow       |
| `≥ xl` (1280px)      | **`org › workspace › project`**, the full path           | 428px, 0 overflow at 1280                      |

> **⚠️ AMENDED by MOTIR-2674 (2026-08-11): the `md`–`xl` org tier now shows its NAME, not its mark.**
> The row above used to read _"the org as its MARK (name hidden)"_, and that was correct only while
> the org HAD a mark. `docs/decisions/entity-marks.md` §2 deletes `OrgAvatar`, and a tier whose only
> rendered content was the mark becomes **a ghost button holding a chevron** — focusable, operable
> and mute. Revealing the name is what gives it content again.
>
> **It was measured, not assumed, and it is nearly free:** at 768px the name costs **+2px** against
> today's mark form (244 vs 242) and at 1024px **+7px** (240 vs 233); overflow stays **0** at every
> band. The mark was never buying width — it was buying the _appearance_ of compactness.
>
> Rejected alternatives: dropping the org tier entirely below `xl` (the path then jumps from one tier
> to three, and the org stops being the permanent anchor Story 6.10.5 made it); and capping the name
> harder to save the 2px (a cap that saves 2px is not a cap, it is a truncation nobody asked for).

Three consequences worth stating plainly, because each is a decision and not a fallout:

1. **The full three-tier path starts at `xl`, not at `md`.** At `md` the labelled-at-`lg` right
   cluster leaves the left one about 220px, and `org-mark › workspace › project` needs ~330px. It
   does not fit, and no amount of character-capping makes it fit without making all three names
   unreadable. So the workspace tier — the tier that is ALREADY conditional — is the one that waits.
2. **Below `md` the bar carries the PROJECT, not the org.** This inverts what ships today, and it is
   the right way round: the project is the tier a person consults most, and the ancestors have a
   drawn home at that width — the `SidebarDrawer` header, which renders `ShellTierNav` and keeps
   `org › workspace` at every width. **The drawer header is UNCHANGED by this design.** What changes
   is that the project is no longer _inside_ the drawer body; it is in the bar, one tap closer.
3. **The project tier is the row's elastic element, so it SHRINKS.** `ProjectSwitcher`'s trigger
   drops `w-full` (it is no longer a 216px rail slot) and takes `min-w-0 shrink`, with the name
   `min-w-0 max-w-[22ch] truncate`. Without the `min-w-0` the button refuses to shrink and the label
   is overrun by the next control instead of ellipsizing — which is exactly what the render shows
   happening to today's bar at 768px, and is why this is specified rather than left to the code card.

**The rule for the next tier.** The path is closed at ONE tier below `md`, TWO from `md`, THREE from
`xl`. A tier added to the path is an `xl`-and-up tier by default; to appear earlier it must displace
one, and the displaced one needs a drawn home — which is the drawer header, and the reason that
header keeps the full ancestor path at every width.

### The three states the project tier inherits

`SidebarHeader.tsx` resolves three states no other rail row needs. All three move with the control:

| state            | in the rail today                                    | in the bar                                                                                                                                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| active project   | `ProjectSwitcher` trigger, `w-full` in a 216px slot  | the same trigger, `min-w-0 shrink`, name capped at 22ch                                                                                   |
| archived project | the same trigger + `Pill tone="archived"`            | unchanged — the pill is `shrink-0`, so the NAME truncates around it, never the pill                                                       |
| **no project**   | a lavender `Card` CTA, full width, opening the modal | the same action in the ghost-button grammar the other tiers use: the accent `+` square + the label, opening the same `CreateProjectModal` |

A full-width tinted card cannot be a tier in a horizontal row; the ghost button can, and it keeps
the door in the same place a person now looks for project context.

> ### ⚠️ AMENDED 2026-09-08 — THE THIRD STATE IS RETIRED (MOTIR-4873)
>
> **There are TWO states now.** The `no project` row above, and the paragraph
> under it, describe a state the product no longer produces: a default project
> is seeded at the WORKSPACE tier (MOTIR-4870), so `getActiveProject()` returns
> null on no path a member can take, and `ProjectTier` renders the switcher
> unconditionally.
>
> **The row is kept rather than deleted**, and so is Panel C's third column,
> because this asset is a record of a decision as well as a specification: the
> ghost-button re-homing was the RIGHT answer to the question it was asked, and
> a reader meeting that reasoning elsewhere should land on why it stopped
> applying rather than on nothing. What changed is the premise underneath it —
> that a projectless reader exists — not the judgement about how to draw a door
> for one.
>
> **The door itself is not lost, only its placement.** Creating an ADDITIONAL
> project is a real act with a real home: the project switcher, which this tier
> now always renders, and which carries both `CreateProjectModal` and _Plan a
> new project with AI_. What is gone is the create-first door offered to
> somebody with nothing — which was always a workspace-tier act being performed
> on a route that only exists inside a project.
>
> **The mock now agrees with this section (MOTIR-4884, 2026-09-14).** MOTIR-4873
> left the board drawing the no-project state as a current one, deliberately, for
> a design pass to reconcile. That pass chose to **mark the state RETIRED IN
> PLACE** — Panel C's two no-project renders (1280px and 375px) and Panel E's
> _no project_ rail column each carry a `Retired · MOTIR-4873` tag in their
> caption and a dashed frame, and both panels' intros say in the past tense what
> the door was for.
>
> **Why in place, and not the two alternatives.** _Dropping the renders_ would
> leave this row and the paragraph under it arguing for a drawing nobody can
> see — the record the row is kept for would lose its picture. _Moving them into
> a separate "what this replaced" band_ would split one comparison across two
> panels: the no-project column is only legible beside the active and archived
> columns it was designed to sit with. Panel A already sets the precedent —
> it is captioned _"what ships today"_ and kept as a before-state rather than
> erased.
>
> **The drawing keeps its full ink.** A retired frame is not dimmed, because
> dimming would take its text below AA and a board's annotations owe contrast
> too (`docs/decisions/design-board-chrome-aa.md`); the dashed edge and the tag
> carry the status instead.

### The rail head, after the project leaves

The rail answers _where inside this project can I go_. Its head was answering a different question,
which is why it needed three states nothing else in the rail needs. **The default-area rail head is
REMOVED** — the rail starts at its first nav section — in both the expanded and the collapsed rail
(the collapsed 32px `ProjectAvatar` goes with the rest), and in the drawer body. The settings and
account areas keep their own headers (`SettingsSidebarHeader`, `AccountSidebarHeader`) untouched;
`SidebarNav` still reads `activeProject` for its nav sections and its settings-area swap.

### The brand tile

**⚠️ AMENDED by [MOTIR-8932](motir:cmvdnhsl4007hhmov6lq1dkmv) (2026-11-06): the tile now matches
motir.co's primary-colour tile.** The top bar's home link draws the mark exactly as motir.co's header
does (its `BrandTile` component, in the `motir-marketing` repository — the same artwork as `app/icon.svg`): the
wave in the palette's primary on a rounded square washed with it. MOTIR-2557's neutral tile — an
`--el-surface` field, an `--el-border` hairline, the glyph in `.brand-glyph`'s
`--el-accent-on-surface` — is overturned; its table and reasoning are replaced below, not kept beside
them.

The 32px box in `TopNav.tsx` keeps its geometry and its gates —
`hidden h-(--height-control-32) w-8 flex-none items-center justify-center rounded-(--radius-control) md:flex`
(the radius now shapes only the focus ring) — and holds one `aria-hidden` SVG that fills it:

| element      | token / value                                             | default palette (`motir`)          |
| ------------ | --------------------------------------------------------- | ---------------------------------- |
| the tile     | `<rect>` `fill-(--el-logo-tile)`                          | #bdd1ee light · #2c3b52 dark       |
| the mark     | `WAVE_BAND_PATH` `fill-(--el-logo-mark)`                  | #155bc4 light · #7db1ff dark       |
| mark on tile | —                                                         | **4.07:1** light · **5.18:1** dark |
| the shape    | 32-unit square, `rx="7"` (7/32 of the side)               | —                                  |
| the inset    | `translate(6.32 6.32) scale(0.8067)` — the wave at 0.8067 | —                                  |
| no field     | no `--el-surface`, no `--el-border` hairline on the Link  | —                                  |

The pair clears WCAG 1.4.11's 3:1 in all twenty palette × theme contexts; the lowest is amethyst dark
at **3.86:1**, and the bright palettes (amber, sienna, citrine, candy) sit their mark on a dark tile at
4.93–13.46:1. `tests/theme/brand-tile-contrast.test.ts` re-derives every one of them from
`theme.css`.

What this pins, and why it overturns what stood here:

- **One identity across the two products.** The reason for the change is the one the card states:
  the mark at the top left of app.motir.co should look like the one at the top left of motir.co. Two
  renderings of the same logo, one boxed in grey and one on its own colour, read as two brands.
- **The neutral-field reasoning no longer holds.** MOTIR-2557 (and MOTIR-2674's re-affirmation)
  chose a neutral field so that the box would mark identity rather than read as a tier chip. The
  logo tile is not a tier chip: it is the brand's own artwork, the same square the tab icon and
  motir.co draw, and it is still the only boxed element in the left cluster. The tint argument was
  about a SECOND lavender chip beside the org and project squares; those squares are gone
  (MOTIR-2679), and the logo tokens follow the palette rather than borrowing a tint slot.
- **The colour comes only from the `--el-logo-*` tokens**, never a hex, so the tile follows
  light/dark and every `data-palette`. Both tokens already exist for every theme and palette in
  `packages/design-system/theme.css`.
- **`.brand-glyph`'s global rule is unchanged.** It is still the colour of every other brand surface
  — auth, `ExploreTopBar`, `PublicTopBar`, the OG images, the specimen — and the top bar simply no
  longer uses it. This SVG does not carry the class, because that rule's ink would override the fill.
- **The hairline DIVIDER stays removed.** §7a introduced it to say the brand sits outside the tier
  hierarchy; the tile's own edge says that, and the 9px stays with the row.

### The target panels were CORRECTED, not supplemented (MOTIR-2674)

The first version of this pass added Panel G and left Panels B, C and E drawing the org mark and the
project's preset chip. That is a worse state than not having amended the asset at all: two targets in
one file, with nothing saying which is authoritative, and the older one appearing first.

**Panels B, C and E now draw the target** — no org mark, no preset chip, the org's name revealed from
`md`. **Panel A deliberately still draws both marks**: it is captioned _"what ships today"_ and is the
before-state the 320px finding is measured against; an asset that erases its own history cannot show
what changed. The correction is applied by `scripts/apply-entity-marks.mjs`, which is idempotent and
committed, so the transformation is auditable rather than a hand-edit nobody can re-check.

### The MARK — pinned once here, applied everywhere (MOTIR-2674)

`docs/decisions/entity-marks.md` decides WHAT a mark is; this pins how it renders, so the
projects-area asset (`MOTIR-2675`) and the two code cards apply ONE specification instead of each
inventing a compatible-looking one. The mark appears in four places — the bar's project tier, the
switcher's open list, the settings-area rail header, and the settings Details row — and they must be
the same object at different sizes.

| property   | value                                                                            | why                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| shape      | **square**, `--radius-control`                                                   | inherits the shipped org chip's deliberate square-vs-round split from the USER avatar (`OrgControl`'s own comment)     |
| size       | **20px** in the bar and the switcher rows · **52px** on the settings Details row | 20px is the slot the ladder is measured against; 52px matches the Account Photo row this composes from                 |
| fit        | `object-fit: cover`, centred                                                     | an uploaded logo is rarely square; cover fills the box without letterboxing, and centre is where a logo's subject sits |
| overflow   | `overflow-hidden` on the box                                                     | the radius must clip the image, not sit behind it                                                                      |
| alt / a11y | decorative (`aria-hidden`) wherever the project NAME is adjacent                 | the name already carries the accessible name; a second one would double-announce the tier                              |

**The EMPTY case, which is the decision's whole visible surface.** When a project has no image:

- **Nothing renders. The box is not reserved** — no placeholder, no dashed outline, no picture glyph,
  no monogram, no generated tint. The tier collapses to its name and the gap closes.
- **⚠️ AMENDED by MOTIR-2675 (2026-08-11), after drawing it: in a LIST the NAME keeps one left
  edge.** This clause used to read _"rows do not indent to a phantom column … the row's text
  therefore shifts left"_, and it was written without a list in front of it. `MOTIR-2675` drew the
  switcher at four rows, two imaged and two not, and **the ragged name edge reads noticeably worse
  than this predicted** — the un-imaged names hang left of the imaged ones and the list stops
  scanning as a column.
  **The corrected rule: a LIST row holds the 24px slot open; the BAR does not.** Nothing is drawn in
  that slot — no border, no fill, no glyph — so the no-mark rule holds exactly; what is preserved is
  ALIGNMENT, which is a property of the list rather than a mark. A single BAR tier has no column to
  align to, so there the gap simply closes. Measured after the fix: all four names start at the same
  x. Recorded here rather than only in the projects asset, because a spec that two assets disagree
  about is worse than either answer.
- The rule this encodes: **an empty slot states a true fact** — nobody has set one. A generated tile
  states a false one, in the same visual weight a real logo would use.

### The element split with MOTIR-2546 — WITHDRAWN (MOTIR-2674, 2026-08-11)

This section used to hand the ORG tier's mark to `MOTIR-2546` — _"an uploaded avatar, or nothing at
all, plus the switch-org rows' chips"_ — and keep only the CLUSTER for this asset. **That split is
withdrawn, because the card on the other side of it no longer exists and the thing it was to own no
longer exists either.**

- **`MOTIR-2546` is ARCHIVED**, with the rest of the organization-mark work under `MOTIR-2542`
  (`MOTIR-2544`'s `Organization.image` column, `MOTIR-2547`'s shared upload primitive, `MOTIR-2549`'s
  header control). Verified on `origin/main`, 2026-08-11: there is **no `AvatarUploadField`**, **no
  `Organization.image`**, **no org upload route** and **no org prefix in `lib/blob/referencedUrls.ts`**.
  Those cards reached `in_review` and were never merged.
- **An organization now carries NO mark at all** — `docs/decisions/entity-marks.md` §2. There is no
  uploaded org avatar to draw, so there is no element left to allocate.

**So this asset owns the org tier's presentation outright**, and what it draws there is the NAME (see
the amended ladder). The switch-org rows lose their initial chip with the trigger's — one entity, one
answer; a chip that survives only inside a popover would be the third rendering of a mark the product
has decided not to have.

**Kept as a record rather than deleted:** a reader who finds `MOTIR-2546` cited in an older commit,
or the two-owner sentence in a cached copy of this file, needs to be able to see that the boundary was
retired deliberately and by whom, not wonder which asset is authoritative.

### What this design overrides

Three areas made narrow-width claims in passing, while designing something else. Two of them were
never built, and one is contradicted by the render.

1. **`design/ai-chat/design-notes.md:458`** — the pill is _"present on every screen, never covering
   content"_. **Retracted below `md`.** Measured: at 375px the pill's box is `x 24–76` and the
   hamburger's is `x 16–52`; it covers 28 of the hamburger's 36px. Replaced by: the pill is a
   `md`-and-up control, and below `md` the `PlanWithAIFab` orb is the door. The _intent_ of the
   sentence — one universal entrance, always reachable (`notes.html` #83 / #89) — is preserved
   exactly, because the orb ships and is mounted under the same gate.
2. **`design/ai-chat/design-notes.md:786` and `:1015`** — the eight-control order
   `[Plan with AI] [Build in public] [+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]`.
   **Kept unchanged from `md` up**, where all eight are present; superseded below `md` by the
   four-slot set, which preserves the relative order of the controls that remain.
3. **`design/notifications/design-notes.md:44-47`** — the bell _"inside the off-canvas mobile
   `SidebarDrawer` … renders icon-only"_. **Verified unbuilt** — `components/ui/SidebarDrawer.tsx` on
   `origin/main` imports no notification component, so this was prior art, not a fact (`notes.html`
   #45: do not read "shipped" and believe it). **Overruled for the bell**, which stays in the bar: a
   badge inside a closed drawer conveys nothing, and the bell is the one control with no second door.
   The claim's _form_ is adopted and generalised — displaced shell controls do render icon-only inside
   the drawer, in the utility strip, which is now where that promise lives.
4. **`design/public-projects/design-notes.md:596-606`** — the single stateful slot, _"exactly one,
   never both, never empty"_. **Kept**, and extended: the slot is now stateful in two dimensions,
   state × breakpoint. Below `md` both of its states live in the drawer strip. This section also
   records the measured asymmetry that design did not know it had created (finding 2 above).

### How the render was produced

The asset is generated, not hand-drawn, so it cannot drift from the app:

1. The real `TopNav` is rendered through the repo's own vitest + RTL setup inside `CommandPaletteProvider`
   / `CreateIssueProvider` / `ProjectAccessProvider` / `ReportProvider` / `ThemeProvider` and a
   `NextIntlClientProvider` seeded from `messages/en.json`, in three prop states (private+AI,
   public+AI, self-hosted floor); `container.innerHTML` is dumped per state. The shipped
   `SidebarDrawer` + `SidebarNav variant="drawer"` are dumped the same way.
2. Tailwind compiles `app/globals.css`'s layers over that markup, so the mock's stylesheet is the
   build's own output rather than a retyped token block.
3. The target bars in Panels C–E are those same shipped elements with only the responsive prefixes
   this design changes — so the markup in the asset is the markup the code card ships.

Two harness artefacts, both corrected in the asset and named here so nobody reads them as design:
happy-dom drops a `background-image` whose value is a `linear-gradient()` over `color-mix()`, so the
pill's fill and its shimmer are restored verbatim from `PlanWithAILauncher.tsx`; and because every
frame shares one document, the compiled `@media (width >= …)` blocks are re-emitted scoped to
`[data-vw="…"]` so each frame resolves its own width. Both are properties of the board, not of the app.

---

## The rail's bottom section — every row it renders (MOTIR-4130 · MOTIR-4254)

`rail-bottom-section.mock.html` / `.png` is **the design of record for the authed rail's bottom
section**: the three rows it carries, at all three widths the shell draws, in both arms of every
conditional row.

> ### ⚠️ AMENDED by MOTIR-4845 — BOTH workspace rows LEAVE, and the FLOOR NARROWS AGAIN
>
> The section is **ONE row**: `Settings`. **It is itself conditional on `showSettingsDoor`, so the
> section can render NOTHING** — no heading, no separator, no empty state. That is the first empty
> arm this section has ever had, and `rail-bottom-section.mock.html` DRAWS it at all three widths
> rather than describing it.
>
> **⚠️ This is the MOTIR-4640 arithmetic directly below, NOT MOTIR-4254's, and the two must not
> share a sentence.** `Job runs` was **unconditional** and it **WAS the floor**, so the floor goes
> from one row to zero and **every** deployment loses a row here — not only a configured one.
> `Security` was already conditional and was never in the floor, so it costs the complete arm alone.
> One amendment, two different arithmetics; say which applies to which row.
>
> **Both rows leave for ONE reason, and it is a TENANCY one.** They are workspace-tier destinations
> sitting in the PROJECT's rail — exactly the mismatch MOTIR-4640 removed for the `Git` row a week
> earlier. At the reveal both live in the workspace-settings AREA rail
> (`design/settings/workspace-settings.mock.html`, MOTIR-4844).
>
> **⚠️ `Job runs` NO LONGER NEEDS A ROW HERE — a change of FACT, not a change of mind.** An earlier
> revision of this amendment KEPT it, on §6d grounds: `/settings/workspace/jobs` answered **200 at
> every workspace count** (MOTIR-3502 AC 6) while its siblings 404'd, so this section really was its
> only door below the reveal. **That was true, and it was the wrong repair.** The route answered at
> every count because it was the one workspace-tier surface with **no fold-in** — an unfinished
> collapse rather than a decision. MOTIR-4861 builds it one on `/settings/organization`, so the
> route becomes reveal-gated like its siblings and `docs/decisions/organization-tier.md` §6d — _a
> hidden tier may not remove a capability … relocating a surface preserves its gate_ — is satisfied
> by **RELOCATION**, which is what the rule asks for. MOTIR-4859 is the planning bug; the general
> form is a global lesson: _a hiding rule owes every capability a RELOCATION, and a surface exempted
> from it because it still answers is the tell that one is missing._
>
> **What each departing row's capability is reached by afterwards:**
>
> | the capability                         | where it lives now                                                                           | tier      |
> | -------------------------------------- | -------------------------------------------------------------------------------------------- | --------- |
> | the workspace's require-2FA policy     | **Settings → Workspace → Security** at the reveal; the org page's fold-in below it           | workspace |
> | workspace name / members / danger zone | **Settings → Workspace** at the reveal; the org page's fold-in below it                      | workspace |
> | the workspace's background-job runs    | **Settings → Workspace → Job runs** at the reveal; the org page's **NEW** `Job runs` fold-in | workspace |
>
> The middle row never had a door in this section and is tabled anyway, because the question §6d asks
> is _what is reachable_, not _what left this file_ — and the area rail is where all three land.
>
> ⚠️ **Shipped code is mid-move and that is expected, not a contradiction.** `SidebarNav.tsx` still
> renders both rows. **MOTIR-4847 removes them**, and this amendment is the design it removes them
> to. It is `blocked_by` MOTIR-4861, so the fold-in exists before the row does not.

> ### GIVES / TAKES — MOTIR-4845
>
> Every `MOTIR-<n>` the two amended assets name, swept with
> `grep -o 'MOTIR-[0-9]\+'` over each and de-duplicated.
>
> | card                                                                                                | gives / takes                                   | what                                                                                                                                                                                                                                                                          |
> | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **MOTIR-4847**                                                                                      | **TAKES two rows, and that IS its deliverable** | It builds the removals this amendment draws: the account menu's `Workspace settings` row and BOTH bottom-section rows. Stated as a give in substance — the card exists to perform exactly this, and its criteria already name both rows since the re-plan. No amendment owed. |
> | **MOTIR-4861**                                                                                      | neither                                         | Named as the fold-in that makes `Job runs`' departure §6d-conforming. This amendment draws no part of that section — MOTIR-4844's Panel 4 does.                                                                                                                               |
> | **MOTIR-4844**                                                                                      | neither                                         | The sibling design card. Cited as where both departing rows live at the reveal; its asset is not touched here.                                                                                                                                                                |
> | **MOTIR-4640**                                                                                      | neither                                         | The precedent: the same section, the same narrowing-floor arithmetic, one row earlier. Lifted as reasoning, re-specified nowhere.                                                                                                                                             |
> | **MOTIR-4254** · **MOTIR-4167** · **MOTIR-4130** · **MOTIR-4238** · **MOTIR-4248** · **MOTIR-4237** | neither                                         | This asset's own revision history and the Help-menu / account-menu owners. Records, not scopes.                                                                                                                                                                               |
> | **MOTIR-3502**                                                                                      | neither here                                    | Its AC 6 is retired by this story, but MOTIR-4844's asset is where that is drawn and recorded; this amendment only cites it as the reason the row used to stay.                                                                                                               |
> | **MOTIR-3909** · **MOTIR-3932** · **MOTIR-2374**                                                    | neither                                         | Point-in-time citations in the head comment's revision log.                                                                                                                                                                                                                   |
> | **MOTIR-4843** · **MOTIR-4845** · **MOTIR-4859**                                                    | —                                               | The story, this card, and the planning bug — provenance.                                                                                                                                                                                                                      |
>
> **No TAKES beyond MOTIR-4847's own deliverable**, and that was checked against its criteria: since
> the re-plan they name both rows, the empty arm and the `blocked_by` on MOTIR-4861. Nothing is owed
> an `update_work_item`.

> ### ⚠️ AMENDED by MOTIR-4640 — the `Git` row LEAVES, and this time the FLOOR NARROWS
>
> The section was **three rows** after this amendment: Settings · Security · Job runs. **Its floor
> is `Job runs`, alone.** (MOTIR-4845, above, has since taken `Security` out; the floor sentence is
> unchanged by that move.)
>
> **⚠️ Do not reuse the `Docs`/`Legal` sentence below.** That move could say _the floor did not
> move_ because **both departing rows were already conditional**, so neither was in the floor. That
> is **false of this one.** `Git` was **unconditional** and it **was in the floor**, so the
> arithmetic runs the other way: the floor goes from two rows to **one**, and **every** deployment
> loses a row here — not only a configured one. Saying it was cheap because the last one was would
> be exactly the kind of sentence this asset exists to prevent.
>
> **The row LEAVES rather than disappears**, and to THREE destinations rather than one, because the
> old row had gathered three tiers' business behind a single glyph:
>
> | what was behind the `Git` row     | where it lives now                    | whose tier   |
> | --------------------------------- | ------------------------------------- | ------------ |
> | the host connection's lifecycle   | **Settings → Organisation → Git**     | organisation |
> | your own git account              | **Settings → Account → Git accounts** | user         |
> | which repositories a project uses | **Settings → Project → Repositories** | project      |
>
> **Cited, not restated** — what each of those surfaces contains is that surface's own design to
> state. (An earlier draft of the card sent the whole row to the project's `Code` room, MOTIR-1764's
> subject. That was wrong, and the card was amended: none of the three destinations is that room.)
>
> **The door is not lost.** `lib/settings/organizationSettingsNav.ts` carries a `Git` row of its own
> at the organisation tier, so the capability keeps an entry point — which is what
> `docs/decisions/organization-tier.md` §6 requires (_"relocating a surface preserves its gate"_).
> What ends is a PROJECT rail carrying an ORGANISATION surface, which is the tenancy mismatch this
> whole story exists to remove.
>
> ⚠️ **Shipped code is mid-move and that is expected, not a contradiction.** `SidebarNav.tsx` still
> renders the row, re-pointed at `/settings/organization/git` by MOTIR-4680, whose comment says _the
> ROW stays and is RE-POINTED rather than removed_. That was true **of that card's scope** — the
> surface changed tier and removal was not its job. **MOTIR-4643 removes the row**, and this
> amendment is the design it removes it to.

**⚠️ It carried SIX until MOTIR-4254, and two of them LEFT rather than changed.** `Docs` and `Legal`
moved to the shell's **Help menu** — MOTIR-4238's asset in this area is the design of record for both
doors now,
and **their absent-arm reasoning moved with them**, because it describes those rows rather than this
section. **The FLOOR did not move**: it was _Job runs · Git_ before and after, since both departing
rows were already conditional — so what shortened is the COMPLETE arm, and a deployment that
configures neither url loses nothing. The measurement in the next block is left as it was TAKEN, at
`8d80ac8db`, when six rows shipped: it is the record of the defect this asset was created to fix, and
re-writing it to today's count would destroy the evidence for it.

### Why the area owed this

The section grew one row at a time, and every row was added by a card that was about the
DESTINATION rather than about the rail — a documentation index, a legal document set, an operator's
job-runs surface, a workspace security policy. Adding a row to a nav is a two-line change at the end
of such a card, and nothing in any of their worlds pointed back at an asset in a different area. So
each asset stayed correct about the day it was drawn and quietly wrong about every day since.

**The measurement, at `8d80ac8db`.** Fourteen rails across six assets draw this section, and **not one
of them drew the `Legal` row or the `Security` row**:

| Asset                                  | Rails | The bottom section it draws             | Short by |
| -------------------------------------- | ----- | --------------------------------------- | -------- |
| `desktop.pen`                          | 1     | Settings · Docs                         | **4**    |
| `desktop-collapsed.pen`                | 1     | `settings` · `book-open` (icon-only)    | **4**    |
| `mobile-drawer.pen`                    | 1     | Settings · Docs                         | **4**    |
| `navigation-pending.mock.html`         | 4     | Settings · Job runs · Git · Docs        | **2**    |
| `top-bar.mock.html`                    | 1     | Settings · Job runs · Git · Docs        | **2**    |
| `design/workbench/workbench.mock.html` | 6     | Job runs · Git · Docs (Settings on one) | **2–3**  |

Method: parse each `.pen` as JSON and walk to its `Nav Section Bottom` frame; load each `.mock.html`
in Chromium and enumerate every `[data-surface="sidebar"]`'s rows. **The count is the section's, not
a list of the rows anyone had in mind** — the card that filed this defect enumerated three rows where
six ship, because it inventoried the rows whose provenance it already held rather than reading the
section (MOTIR-4163).

### What the section actually carries

Declaration order, from `app/(authed)/_components/SidebarNav.tsx`'s `sections.push({ id: 'bottom' })`:

| #   | Row          | Glyph         | Destination                                                                          | Rendered                       |
| --- | ------------ | ------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| 1   | **Settings** | `settings`    | the actor's first visible settings room — `/settings/project` (Details) for an admin | CONDITIONAL — that room exists |
| 2   | **Job runs** | `list-checks` | `/settings/workspace/jobs`                                                           | always                         |

> ⚠️ **AMENDED by MOTIR-5319 (2026-09-13) — the Settings row's DESTINATION.** It read
> _"`/settings/project`, else the settings home"_. The _else_ arm was already gone (MOTIR-4873
> removed the no-project state), and the first arm was wrong for a hand-composed partial role:
> `/settings/project` is Details, gated on `project:administer`, so a role holding only
> `board:configure` saw the door and landed on `Admins only`. The row now goes to the first entry of
> the actor's view-gated settings rail — the same filter that decides whether it renders — which is
> still Details for an administrator. `rail-bottom-section.mock.html` draws the administrator's arm,
> so its `href="/settings/project"` is unchanged and correct.

**ONE of the two is conditional, and the section's FLOOR is ONE row** — Job runs, alone. That
floor is the open product's common case, not an edge state, which is why the asset draws it beside
the complete arm at every width rather than describing it. (It was three rows in this asset's first
revision, when the `Docs` row was unconditional and dead — see MOTIR-4167 below; six until
MOTIR-4254 moved two of them to the Help menu; four until MOTIR-4640 took `Git` out; and three
until MOTIR-4845 took `Security` out.)

⚠️ **`Git`'s destination in this table was `/settings/workspace/github` for as long as the row was
listed, and that address stopped existing when MOTIR-4680 moved the surface to the organisation
tier.** The row is gone now so the entry goes with it — but it is worth recording that the row was
stale in TWO ways at once, because that is the failure mode the section's own history describes: a
row added by a card about somewhere else, then re-pointed by another card about somewhere else, with
nothing pointing back here either time.

**The floor is where the whole move is cheap, and it is worth stating as arithmetic rather than as
reassurance.** Both departing rows were CONDITIONAL, so neither was in the floor to begin with. A
deployment that configured neither url saw two rows before this change and sees two after; a
deployment that configured both loses two rows here and gains them in a menu that is on screen at
every width the product supports.

**Nothing marks an absent row.** The rows close up and the section is shorter; there is no disabled
row, no tooltip and no empty state. `SidebarNav.tsx`'s own comment carries the reason and it is the
rule for the whole section: _an entry point is a promise about a room, and a disabled row is a promise
the product then refuses._

**Both departing rows' absent-arm reasoning MOVED to § _The Help menu_ (MOTIR-4254).** The `Legal`
row's two-cause absent arm — the second cause being an operator who publishes at unrelated addresses,
so there is no index to point at and the row is absent rather than guessed — and the `Docs` row's
MOTIR-4167 history are both properties of those ROWS, not of this section, so they travel with them.
They are **moved, not copied**: a second copy here would be the divergence this area's own ledger
exists to prevent, and the next reader would have no way to tell which was authoritative.

**What stays here is the fact about THIS section**: after MOTIR-4845 it is **two rows**, one of
them conditional, and its **floor is one row**. The `Docs`/`Legal` and `Security` moves left the
floor untouched; the `Git` move did not, and the three are not described with the same sentence.

### The divergence ledger — which source wins for this element

| #   | The older assets say                                                                                                    | This asset says                                                                                                                                                                                                                                       | Since      |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `desktop.pen` · `desktop-collapsed.pen` · `mobile-drawer.pen` draw **Settings · Docs** and nothing else                 | **Four rows**, two of them conditional. **This asset WINS for the bottom section**; those three keep the PRIMARY section, the rail head, the top bar and the drawer chrome, which this asset does not draw.                                           | MOTIR-4130 |
| 2   | The three `.pen` sources cannot be corrected in place                                                                   | **They are not edited.** Pencil is not in this tree, so a `.pen` edit produces a source disagreeing with the `.png` every consumer opens — a second divergence, not a fix. The same call `design/auth/` made for its own legacy artboards.            | MOTIR-4130 |
| 3   | `navigation-pending.mock.html`, `top-bar.mock.html` and `design/workbench/workbench.mock.html` draw four rows, or three | Those rails are **context for something else** — a pending grammar, a control budget, a landing surface — and are not the source for this section. They are re-exportable and may be swept, but a reader asking _what belongs here_ reads THIS asset. | MOTIR-4130 |

| 4 | **This asset's own earlier revisions** drew `Docs` and `Legal` as rail rows, and carried their absent-arm reasoning | **Both rows are GONE from this section, and so is that reasoning** — they moved to the **Help menu**, whose asset (MOTIR-4238) is the design of record for both doors now. A rail answers _where inside this project can I go today_; neither door is a daily-work destination. Nothing else moved: the other four rows keep their destinations and their order, and the floor is unchanged at two. | MOTIR-4254 |

| 5 | **This asset's own previous revision** drew `Git` as an unconditional row, and put it in the floor | **The row is GONE from this section**, and its three destinations are named above rather than described. The floor is `Job runs` alone — this move NARROWED it, which the MOTIR-4254 move did not, and the two must not share a sentence. The door survives at the organisation tier's own rail. | MOTIR-4640 |

| 6 | **This asset's own previous revision** drew `Security` (reveal-gated) and `Job runs` (unconditional) | **BOTH rows are GONE from this section**, and they leave under DIFFERENT arithmetics: `Security` was conditional and never in the floor (the MOTIR-4254 shape), `Job runs` was unconditional and WAS the floor (row 5's shape), so the floor goes from one row to **zero** and the section gains its first empty arm. Both are workspace-tier destinations sitting in a PROJECT rail — the tenancy mismatch row 5 removed for `Git`. `Job runs` needed no exception once MOTIR-4861 gave it a fold-in; see the amendment above. | MOTIR-4845 |

### The six assets that draw this section — a disposition each (re-measured for MOTIR-4640)

The count below is **taken by re-running the method**, not copied from the MOTIR-4130 table above:
the three `.pen` sources are parsed as JSON and walked to their `Nav Section Bottom` frame; the three
`.mock.html` assets are loaded in Chromium and every `[data-surface="sidebar"]`'s rows enumerated.

**Fifteen rails across six assets, and TWELVE of them draw the departing `Git` row.**

| Asset                                  | Rails | Draws `Git` | Bottom rows measured now         | Disposition                       |
| -------------------------------------- | ----- | ----------- | -------------------------------- | --------------------------------- |
| `desktop.pen`                          | 1     | **no**      | Settings · Docs                  | unchanged — nothing to amend      |
| `desktop-collapsed.pen`                | 1     | **no**      | icon-only, no text nodes         | unchanged — nothing to amend      |
| `mobile-drawer.pen`                    | 1     | **no**      | Settings · Docs                  | unchanged — nothing to amend      |
| `navigation-pending.mock.html`         | 4     | **yes ×4**  | Settings · Job runs · Git · Docs | **recorded, not amended** (below) |
| `top-bar.mock.html`                    | 1     | **yes ×1**  | Settings · Job runs · Git · Docs | **recorded, not amended** (below) |
| `design/workbench/workbench.mock.html` | 7     | **yes ×7**  | Job runs · Git · Docs            | **recorded, not amended** (below) |

⚠️ **THE SIXTH ROW MOVED AND GREW WHILE THIS AMENDMENT SAT IN REVIEW — which is
the argument for re-running the method rather than copying a table, arriving on
schedule.** It was the LANDING surface's own mock — then named for the `home`
area — with SIX rails when this section was first written; MOTIR-4779 renamed
that surface to `design/workbench/workbench.mock.html`, and it now draws SEVEN. A table carried forward would have cited a file that no longer
exists and a count nobody re-took, and `design-asset-addresses` caught precisely
that — on the merge queue, which is the last place a stale citation is still
cheap. The numbers above are from a re-run against `origin/main` after that
rename landed.

### The same six assets, re-measured for MOTIR-4845 — a disposition each

The method is the one directly above, re-run rather than copied. The question this time is **two**
rows, `Security` and `Job runs`, and the answer is that **only this asset draws either as a
specification** — which is why the shortfall the MOTIR-4130 measurement recorded is still the fact
about this section.

**Measured with `grep -rc 'Security' design/shell/` and `grep -rc 'Job runs' design/shell/` at
`11d4c8541`**, with both outputs on MOTIR-4845's pull request in full:

| File                                                                                          | draws `Security` | draws `Job runs` | Disposition                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ---------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rail-bottom-section.mock.html`                                                               | yes              | yes              | **REDRAWN — this amendment**, both rows out of every arm and the section itself out of the floor arms                                                                              |
| `design-notes.md`                                                                             | yes              | yes              | **AMENDED — this amendment**                                                                                                                                                       |
| `3d-immersive-shell.mock.html`                                                                | yes ×6           | yes              | **recorded, not amended** — six rails LIFTED as context for a spatial exploration whose subject is the plane; that asset's own ledger already says this asset WINS for the section |
| `help-menu.mock.html`                                                                         | yes ×3           | yes              | **recorded, not amended** — a point-in-time record of its own moment, already one generation stale since MOTIR-4640 and correctly so                                               |
| `navigation-pending.mock.html` · `top-bar.mock.html` · `design/workbench/workbench.mock.html` | —                | yes              | **recorded, not amended** — ledger row 3: context for a pending grammar, a control budget and a landing surface, not the source for this section                                   |
| `desktop.pen` · `desktop-collapsed.pen` · `mobile-drawer.pen`                                 | no               | no               | nothing to amend, and they cannot be edited in this tree (ledger row 2)                                                                                                            |

**⚠️ AND THE TWO-WORD LABEL NEEDS A WHITESPACE-TOLERANT PATTERN.** `prettier` wraps
`Workspace settings` across a line inside a mock, so `grep -rl 'Workspace settings' design/` returns
**five files where six hit** — `design/cli-connect/cli-connect.mock.html` is the one it misses.
`grep -rlzP 'Workspace\s+settings' design/` finds all six. A single-word label (`Security`, `Git`)
is unaffected, which is why this had not bitten before. **Any future sweep for a multi-word row
label in this tree owes the tolerant form.**

**Why `recorded, not amended` is the right disposition every time it appears above.** Each of those
assets draws the section as CONTEXT for a subject that is not this section, and each is named in a
divergence ledger that already says this asset wins for it. Amending them would make several files
claim the same element and give the next reader no way to tell which is current — the divergence
this area's ledger exists to prevent, and the exact call MOTIR-4640 made for the same assets one row
earlier.

**Why the three `.pen` sources need nothing.** They never drew `Git` — that is the four-row shortfall
the MOTIR-4130 measurement recorded, and it is unchanged by a row leaving. Ledger row 2 already
settles that they are not edited at all: Pencil is not in this tree, so a `.pen` edit would produce a
source disagreeing with the `.png` every consumer opens.

**Why the three `.mock.html` assets are RECORDED rather than amended, and the evidence for it.**
Ledger row 3 already holds that those rails are context for something else — a pending grammar, a
control budget, a landing surface — and that a reader asking _what belongs in this section_ reads
THIS asset. The measurement supplies the confirming fact: **all twelve of those rails still draw
`Docs`**, a row that left in MOTIR-4254 and was never swept out of them. So leaving them is the
established disposition for a departure here, not a new exemption invented for this one — and
sweeping `Git` while `Docs` stayed would leave them wrong in a way that is harder to reason about
than wrong-as-of-a-date.

⚠️ **What that costs, stated rather than hidden:** twelve rails in this repository will draw a row
the product does not render once MOTIR-4643 lands. They are point-in-time records and this asset is
the source of record for the section — but a sweep of all three, taking `Docs` and `Git` together, is
worth its own card, and nothing here should be read as saying they are correct.

**The toolchain question this card had to answer first, and its evidence.** No `.pen` renderer or
exporter exists anywhere in the repository: the only files naming `.pen` are two guards, `CLAUDE.md`
and `scripts/plan-seed/` data, and `package.json` carries no Pencil dependency and no design-export
script. The one renderer present is `scripts/render-design-mock.mjs`, which takes `*.mock.html`. So
the `.mock.html` route was not a preference — it was the only route with a working export.

### Primitives and tokens

The asset composes **no new primitive**. Every rail is `components/ui/Sidebar.tsx` — `SidebarNavItem`
for a row (`--height-control`, `--radius-control`, `--spacing-control-x`, `--el-text-secondary` ink,
`--el-icon-muted` glyph, `--el-sidebar-item-bg-hover`), the `role="separator"` div between sections
(`--el-sidebar-border`), and the rail itself (`--el-sidebar-bg`, `data-surface="sidebar"` so a
material style can frost it). The drawer chrome is `components/ui/SidebarDrawer.tsx`'s header row
verbatim. Widths are the shipped ones: `AppLayout`'s grid column is **240px** expanded, and
`SidebarDrawer`'s default width is **300px**.

**The COLLAPSED column is not a constant (MOTIR-4232).** It is
`calc(var(--height-control) + var(--width-rail-chrome))` — the one control the collapsed rail holds,
plus the rail's own gutters, border and slack — so it follows the style axis instead of ignoring it.
It is **56px under the default style** (36 + 20), which is what this asset draws and what the rail
has always been; it is 54px under the two densest styles and 60px under `soft-playful` and
`3d-immersive`, whose 40px control did not fit the old 39px content box at all. A mock drawing the
collapsed rail draws the default's 56px and says which style it is drawing.

Board chrome routes every colour through `--el-*` and takes `--el-text-secondary` for body ink rather
than `--el-text-muted`, which fails AA on three of the four surfaces it could land on
(`docs/decisions/design-board-chrome-aa.md`).

### The access path

The section has no entrance to draw: it IS an entrance, and it is always on screen wherever the
authed shell is — beneath the primary section, above the collapse toggle. Below `md` it is reached
through the hamburger, which opens the drawer the asset's Panel C draws.

### How the render was produced

Generated, not hand-drawn, so it cannot drift from the app:

1. The real `Sidebar` is rendered through the repo's own vitest setup with `renderToStaticMarkup`, in
   six states — expanded / collapsed / drawer × complete / floor. **Only the SECTION DATA is
   authored**, and it is the entries `SidebarNav.tsx` pushes — six when this asset was generated, four
   since MOTIR-4254 — with the real `messages/en.json`
   labels, the real hrefs and the real lucide glyphs.
2. `tailwindcss`'s own `compile()` API runs `app/globals.css` over that markup, so the stylesheet is
   the build's output rather than a retyped token block.
3. The frames are measured after rendering: every row's box is asserted inside its frame, so no row
   is clipped or scrolled out of view. **This caught a real defect** — at the first frame height the
   `Legal` row, the one the card is named after, was scrolled out of all three complete arms and the
   asset looked finished.

One board property, named here so nobody reads it as design: the frames give the rail a fixed height
so all ten rows fit, where the real rail is `h-full` in a viewport-height grid column.

**Revised by MOTIR-4254 without re-running the generator either**, for the reason the MOTIR-4167 note
below gives: the change is entirely SECTION DATA — two rows removed from the three complete arms,
absent from the three floor arms already — so every rail in the asset is still the real `Sidebar`
output, edited in the six places the generator's data would have moved. **The frames were re-measured
in a browser rather than assumed**: every drawn row's box asserted inside its frame at all three
widths in both arms (7 rows complete / 5 at the floor per width, the abbreviated primary section
included). Removing rows can only shorten the content, and _"can only"_ is exactly the reasoning that
produced the defect the measure step exists for. `prettier --write` then
`scripts/render-design-mock.mjs` re-exported the `.png`.

**Revised by MOTIR-4167 without re-running the generator.** The generator was a temporary harness
(deleted with MOTIR-4130's run, as the design lane's own rule requires), and the revision changes
only the SECTION DATA it would have been fed: the `Docs` row's `href` in the three complete arms, and
the row's absence from the three floor arms. Those are the two edits made to the generated markup,
so every rail is still the real `Sidebar` output; `prettier --write` then
`scripts/render-design-mock.mjs` re-exported the `.png`.

### What this asset does NOT draw

The **primary** section (`desktop.pen` still owns it — the four rows above the separator are
abbreviated context, not a specification), the rail **head** (`context-row.mock.html`), the collapse
**toggle** in the footer, and the drawer's **utility strip** (`top-bar.mock.html` Panel D, MOTIR-2374).

---

## The account menu — every row it renders (MOTIR-4248)

`account-menu.mock.html` / `.png` is **the design of record for the avatar popover in the authed top
bar**: its trigger drawn inside the bar at each of the bar's own three states, the menu open, every
row the component can render, and both arms of every conditional one.

### Why the area owed this

The rail's bottom section owed an asset because it grew a row at a time and nobody owned the list.
The account menu owed one for the opposite reason: **it never grew at all, so nobody ever had a
reason to draw it** — and then the first card to reach for it found there was nothing to reach for.

**Neither drawing was a mistake, and that is the point.** Each of the two below was correct about the
journey it was explaining, and neither was trying to describe the menu. A door drawn in another
area's asset is evidence that the ROOM is required, not evidence that it is designed — so
`design/shell/` becomes the design of record for this surface, the way it already is for the rail's
bottom section.

### The measurement, at `origin/main` `ee8dd322d`

**The population.** Twelve files under `design/` name the string:

```
git grep -l 'Account settings' origin/main -- 'design/'      # → 12 files
```

Ten of the twelve are the account-settings **area label**, a different thing entirely — eight in
`design/settings/` (seven mocks and its `design-notes.md`), plus `design/cli-connect/design-notes.md`
and `design/platform-admin/design-notes.md`, which describe their own panels. **Exactly two DRAW the
menu open.**

**⚠️ The count was re-taken under a stricter predicate, because a `git grep` is line-oriented and
prettier wraps these assets.** `>Account settings<` is written across two lines in both of the assets
that matter, so a single-line pattern under-reads them — which is exactly how the row inventory below
was first got wrong (see _Corrections_). Re-run over file CONTENT rather than lines, the file count
is unchanged at twelve:

```
git ls-tree -r --name-only origin/main design/ \
  | xargs -I{} sh -c 'git show origin/main:{} | tr "\n" " " | grep -q "Account  *settings" && echo {}'
```

**And the PREDICATE was widened as well as the ref**, because the claim quantifies over _assets that
draw this menu_ while the command enumerates _files naming one of its rows_. Searching `design/` for
**any** of the four row labels returns fifteen files: the twelve above plus `design/shell/cmd-k.pen`
(a _Sign out_ row in the command palette's **Account** group, beside _Toggle theme_ — a different
surface, correctly owned by that asset) and `design/workspaces/design-notes.md` /
`settings.pen` (_Workspace settings_ as a page name). **The two-asset finding survives the wider
predicate.**

### What the two passing-through assets actually draw

| Asset                                             | The rows it draws                                                                                           | Why it drew them                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `design/cli-connect/cli-connect.mock.html`        | identity block · Account settings · Workspace settings · Sign out                                           | Panel 0's access path — _avatar menu → Account settings_ |
| `design/platform-admin/console.mock.html` Panel 1 | an _Account_ head label + the email · Account settings · **Your organizations** · Platform admin · Sign out | the staff-only door into `/admin`                        |

**They disagree with each other, and both disagree with the shipped component — in three separate
ways, only one of which is an omission:**

1. **Rows that are missing.** `cli-connect` draws no _Platform admin_; `console` draws no
   _Workspace settings_.
2. **A row that does not exist.** `console` draws **_Your organizations_** with a `users` glyph.
   `UserMenu.tsx` has never rendered such a row. A reader taking that asset as the answer to _what is
   in this menu_ would build a row the product does not have.
3. **A glyph that is wrong.** `console` gives _Account settings_ the `settings` glyph; the component
   uses `user-cog`, and `settings` is _Workspace settings_'s glyph — so the one asset that draws
   neither of those rows correctly is also the one that swaps their icons.

Both are drawn as **hand-built stand-in markup** rather than as the component's own output, which is
why they could drift without anything noticing. This asset cannot: every menu in it is rendered.

> **⚠️ A FOURTH disagreement arrived with MOTIR-4845, and both assets keep their disposition.**
> `cli-connect.mock.html` still draws a `Workspace settings` row and `console.mock.html` still draws
> none, so as of that amendment the first is a row ahead of the component and the second is level
> with it by accident. **Neither is amended**, for the reason this whole section gives: they draw
> the menu as CONTEXT for their own access path, this asset wins for the surface, and a menu
> recorded in three places is a menu recorded in none. They are point-in-time records of their own
> moments — the same call `design/shell/` already makes for its three `.pen` sources.
>
> **⚠️ AND THE SWEEP THAT FINDS THEM NEEDS A WHITESPACE-TOLERANT PATTERN, which is a fact about
> this tree rather than about these assets.** `prettier` wraps a two-word label across a line, so
> `cli-connect.mock.html` carries `Workspace\n settings` and a plain
> `grep -rl 'Workspace settings' design/` **does not find it** — it returns five files where six
> hit. `grep -rlzP 'Workspace\s+settings' design/` returns all six. Any future sweep for a
> MULTI-WORD row label in this tree owes the tolerant form; a single-word one (`Security`, `Git`)
> is unaffected, which is why this had not bitten before.

### What the menu actually carries

Declaration order, from `app/(authed)/_components/UserMenu.tsx`:

| #   | Row                  | Glyph      | Destination                                       | Rendered                                             |
| --- | -------------------- | ---------- | ------------------------------------------------- | ---------------------------------------------------- |
| —   | **Identity block**   | —          | — (the name, and the email beneath it when set)   | always                                               |
| 1   | **Account settings** | `user-cog` | `/settings/account`                               | always                                               |
| 2   | **Platform admin**   | `shield`   | `/admin`                                          | CONDITIONAL — `platformStaff`, a separator each side |
| 3   | **Sign out**         | `log-out`  | — (a button; signs out and bounces to `/sign-in`) | always                                               |

> ### ⚠️ AMENDED by MOTIR-4845 — the `Workspace settings` row LEAVES, and an AXIS leaves with it
>
> It sat **second**, `settings` glyph, `/settings/workspace`, conditional on
> `workspaceTierRevealed` — a workspace-tier destination filed under the user tier, one line under
> _Account settings_ and one above _Sign out_. Its destination is the **workspace switcher**, the
> control that already names the tier, and `design/settings/workspace-settings.mock.html` panel 5
> (MOTIR-4844) is that row's design of record now. MOTIR-4847 performs the move in the components.
>
> **THE FLOOR IS UNCHANGED at two rows** — the departing row was conditional, so it was never in it.
> What shortens is the COMPLETE arm, four rows to three.
>
> **The asset drew FOUR frames and draws TWO, and that is the part worth stating.** This was the
> only row in the menu conditional on anything but `platformStaff`, so the two conditionals that
> made four state combinations are now one that makes two: the two departing frames differed from a
> survivor by exactly that row. **The menu no longer varies by workspace count at all.**
>
> The tier-disclosure sentence below loses one of its two legs with it, and the remaining leg is
> unchanged.

**ONE of the three is conditional and the menu's FLOOR is two rows** — _Account settings_ ·
_Sign out_, the pair every session gets. Nothing marks an absent row: the rows close up and the menu
is shorter, with no disabled row, no tooltip and no empty state. That is the same line the rail draws
for the same reason — _an entry point is a promise about a room, and a disabled row is a promise the
product then refuses_ — and here it is load-bearing because the component's own prop documentation
makes it so: an absent _Platform admin_ is half of the 404-not-403 posture for `/admin`
(`docs/decisions/platform-staff-auth.md` §2 / §4). A present-but-dimmed row would defeat it.
(Until MOTIR-4845 it was load-bearing TWICE over: an absent _Workspace settings_ was the whole of
the tier disclosure, `docs/decisions/organization-tier.md` §6d. That leg went with the row — the
disclosure is now the switcher's own absence below the reveal, which is drawn in
`design/settings/workspace-settings.mock.html`.)

**Both `role="separator"` rules belong to the staff row and leave with it.** They bracket
_Platform admin_ rather than dividing the menu, so the non-staff arm carries none — which is why the
asset drew four combinations before MOTIR-4845 and draws two now. **The identity block's bottom
border is not one of them**: it is a `border-b` on the block, not a `role="separator"`.

### The access path

**Drawn, not described** — Panel A puts the avatar trigger inside the top bar at all three of the
bar's own states, because a door in this menu is only a door at the widths it survives:

| Bar state         | What the bar draws                                     | Where the avatar is       |
| ----------------- | ------------------------------------------------------ | ------------------------- |
| `≥ lg` (1024px)   | all eight controls, labelled                           | last in the right cluster |
| `md`–`lg` (768px) | all eight, icon-only; the brand replaced the hamburger | last in the right cluster |
| `< md` (375px)    | **four** controls — palette · create · bell · avatar   | **SLOT 4 of four**        |

At `< md` the rail has folded into a drawer behind the hamburger and the avatar has not moved: it is
still on screen, holding the last of the four slots `top-bar.mock.html` Panel B's budget allows. **A
row added to this menu costs no slot at any width** — the menu's own length is not budgeted, only the
bar's control count is — and that is the whole of this asset's claim on the bar. The budget itself is
`top-bar.mock.html`'s and is not re-derived here.

### The divergence ledger — which source wins for this surface

| #   | The other assets say                                                                                                                                                                               | This asset says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Since      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `cli-connect/cli-connect.mock.html` draws three rows (no _Platform admin_); `platform-admin/console.mock.html` Panel 1 draws four, one of which (_Your organizations_) the product does not render | **Four rows plus the identity block, two of them conditional. This asset WINS for this surface.** Those two are point-in-time records of their own access paths and are **not edited** — the same call `design/shell/` already made for its three `.pen` sources.                                                                                                                                                                                                                                 | MOTIR-4248 |
| 2   | Both of those draw the menu as hand-built stand-in markup, and one swaps the `user-cog` and `settings` glyphs                                                                                      | **Every menu here is the real `UserMenu`, rendered and opened**, so it cannot drift from the component. A reader asking _what is in this menu_ reads THIS asset.                                                                                                                                                                                                                                                                                                                                  | MOTIR-4248 |
| 3   | `top-bar.mock.html` draws the avatar trigger at `h-9 w-9` — a FIXED 36px                                                                                                                           | **The trigger is `--height-control` square**, which is what ships (MOTIR-2373 moved it off the fixed size). The two agree at 36px under the default style and under `warm-editorial` and `neo-brutalism`, and **diverge under the other nine of the eleven shipped `[data-style]` values**, where `--height-control` is 34, 38 or 40px. **`top-bar.mock.html` still wins for the bar's COMPOSITION and its control budget**; this asset wins for the avatar's own box and for the menu behind it. | MOTIR-4248 |

### Primitives and tokens

The asset composes **no new primitive and no new token**. The menu is `components/ui/Popover.tsx`
(`data-surface="popover"`, so a material style can frost it) at `UserMenu`'s own `width={240}`; every
row is `UserMenu.tsx`'s own treatment — `--radius-control`, `--el-text` ink, `--el-text-muted` glyph,
`--el-surface` hover/focus field — the rules are `role="separator"` on `--el-border`, the staff row's
glyph is `--el-info` and its hint line `--el-text-secondary`, its chip is the shipped `Pill`
(`tone="neutral"`), and the trigger is an `--el-text` circle with `--el-text-inverted` ink at
`--height-control` square.

Board chrome routes every colour through `--el-*` and takes `--el-text-secondary` for body ink rather
than `--el-text-muted`, which fails AA on three of the four surfaces it could land on
(`docs/decisions/design-board-chrome-aa.md`).

### How the render was produced

Generated, not hand-drawn, so it cannot drift from the app:

1. The real `UserMenu` is rendered through the repo's own vitest setup (happy-dom + the real `en`
   catalog via `renderWithIntl`) and the menu is **OPENED**, so what the asset carries is Radix's own
   portal output. **Only the STATE is authored** — which of the two conditionals are on — in the
   four combinations they have between them. The attributes Radix writes at RUNTIME (generated ids,
   the focus trap's `tabindex`, the popper's inline custom properties, and the `data-side` /
   `data-align` its collision detector resolved against a zero-size test viewport) are stripped, so
   the asset is a drawing of the component rather than a snapshot of one mount.
2. The three top bars in Panel A are **lifted from `top-bar.mock.html`**, which owns the bar's
   composition — this asset draws the access path and composes that asset rather than re-specifying
   it. The one substitution is the avatar BUTTON, for the reason ledger row 3 gives; the generator
   asserts the freshly rendered trigger's `--height-control` box appears in all three bars before
   lifting them, so the bars cannot be a stale drawing of a trigger that has moved.
3. `tailwindcss`'s own `compile()` API runs `app/globals.css` (with its two package imports resolved
   through node's resolver) over the assembled markup, so the stylesheet is the build's output rather
   than a retyped token block.
4. **Each bar renders at its own width inside one document**, so the compiled `@media (width >= …)`
   blocks are re-emitted scoped to `[data-vw="W"]` — the same rules, resolved per frame. That is
   `top-bar.mock.html`'s own mechanism, reproduced here because this asset lifts that asset's bars;
   it is a property of the BOARD, not of the app.
5. **The frames are measured after rendering, in a browser**, and the measurement is what makes the
   panels' claims checkable rather than captioned: every drawn row's box is asserted inside its own
   popover and inside its frame, the avatar is asserted square in each bar, and the `< md` bar's
   right cluster is asserted to hold **exactly four** controls with the avatar last. The measure
   separates _not drawn at this width_ (a control the bar's breakpoints correctly hide — a zero box)
   from _clipped_ (a drawn box outside its frame); conflating the two is what made an earlier pass on
   the rail asset report false failures on a correct render.

The generator and the measurement script were temporary harnesses and are **deleted with this card's
run**, as the design lane's own rule requires.

**Three caption sentences were amended after generation, without re-running the generator**, and the
distinction is the one that matters: they are authored prose in `<p class="panel-n">` /
`<p class="legend">`, never rendered markup, so every menu and every bar in the asset is still
component output untouched by hand. Two of them carried an argument belonging to the story this
asset's work was originally cut from (a row being moved into this menu, which is not happening here);
the third claimed Panel C's Glyph column renders the `lucide-react` element, when it names it and
Panel B renders it. `prettier --write` and then `scripts/render-design-mock.mjs` re-exported the
`.png`, and the browser measurement was re-run against the file that ships.

### Corrections

**The card that commissioned this asset (MOTIR-4248) got one cell of its evidence table wrong, and
the correction is recorded here rather than only on the card**, because the table is what a later
reader will copy. It said `platform-admin/console.mock.html` Panel 1 draws _"identity block · Account
settings · Platform admin"_ and that it _"omits Workspace settings and Sign out"_. It draws **Sign
out**, and it draws a fifth row — **Your organizations** — that the shipped component has never
rendered. The under-read has one cause and it is worth naming: the inventory was taken with a
line-oriented `grep` for `>Account settings<`, and prettier wraps these assets so that the label and
its closing tag sit on different lines. **A row inventory over a formatted HTML asset is taken over
file CONTENT, not over lines.** Both corrections make the card's finding stronger rather than weaker,
which is why the asset ships: the two drawings disagree with the component more than the card claimed,
not less.

### What this asset does NOT draw

The **top bar's own composition** and its control budget (`top-bar.mock.html` owns both; Panel A
composes that asset), the **drawer's utility strip** (`top-bar.mock.html` Panel D), the destinations
behind any of the rows (`design/settings/`, `design/platform-admin/`), the **rail** in any form
(`rail-bottom-section.mock.html`, `desktop.pen`, `context-row.mock.html`), and the **command
palette's own Account group** (`cmd-k.pen`), which carries a _Sign out_ row of its own on a different
surface.

---

## The Help menu — its two homes, and the three doors it holds (MOTIR-4238)

`help-menu.mock.html` / `.png` is **the design of record for the shell's Help menu**: a control in the
rail's footer at `≥ md` and in the drawer's utility strip below it, opening a popover with three rows.

### Why the shell owes this surface

The rail's bottom section carried `Docs` and `Legal`, and `SidebarNav.tsx`'s own comment said why:
_"It sits HERE rather than in a footer because the authed shell has no footer to put it in."_ That is an
honest note about a missing slot, not an argument for the rail — and it had been standing in for a
decision ever since. **This asset draws the slot.**

**The mirror, read from source rather than recalled** (rung 1 of the decision-authority ladder — a
citation from memory is not a check):

| product        | where these doors live                                                                                     | read from                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitLab**     | the **Help menu** in the super-sidebar — `GitLab documentation`, `Keyboard shortcuts`, `Terms and privacy` | [`help_center.vue`](https://github.com/gitlabhq/gitlabhq/blob/master/app/assets/javascripts/super_sidebar/components/help_center.vue)                  |
| **Sentry**     | the **Help menu** in the primary nav — a `Legal` submenu over `Privacy Policy` / `Terms of Use`            | [`helpMenu.tsx`](https://github.com/getsentry/sentry/blob/master/static/app/views/navigation/primary/helpMenu.tsx)                                     |
| **Plane**      | a **help menu in the sidebar** — Documentation · Contact sales · Keyboard shortcuts · What's new · Forum   | [`help-section/root.tsx`](https://github.com/makeplane/plane/blob/preview/apps/web/core/components/workspace/sidebar/help-section/root.tsx)            |
| **Mattermost** | the auth footer + the **About** dialog                                                                     | [`about_build_modal.tsx`](https://github.com/mattermost/mattermost/blob/master/webapp/channels/src/components/about_build_modal/about_build_modal.tsx) |

**Two things are unanimous.** None puts these doors in the product navigation, and none puts them in
the account menu — all four keep that surface for _acts on your account_. Three of the four put help in
the **sidebar**; not one puts it in a top bar.

### Where the control lives, and why there

**At `≥ md`: the rail's FOOTER** — `Sidebar`'s `footer` slot, which holds
`<SidebarToggle variant="footer" />` alone today (`SidebarNav.tsx:226 · 253 · 572`). The footer is
**chrome, not a destination list**, which is the whole distinction: the rail answers _where inside this
project can I go today_, and none of these three doors is a daily-work destination.

**Below `md`: the DRAWER'S UTILITY STRIP.** `SidebarNav` passes `footer={isDrawer ? undefined : …}`, so
**the drawer renders no footer at all** and a footer-only control would vanish at phone width — the
exact failure this story exists to remove, not to repeat. The strip (`SidebarDrawer`'s own `footer`,
rendered at `app/(authed)/layout.tsx:455`) is the shipped home for a displaced control: MOTIR-2373 moved
the build-in-public slot, the report button and the theme toggle there when the top bar's budget closed,
and its rule is that the displaced control lands there **drawn, not cited**. This asset draws it.

**NOT a new top-bar control.** The below-`md` bar is closed at four slots and this would be the ninth
(`top-bar.mock.html` Panel B). That ceiling is arithmetic, not taste.

### The two widths need two arrangements, and both are drawn

The footer is the one region that survives the collapse, and it now holds two controls rather than one.

- **Expanded (240px)** — a row: Help leading, the collapse toggle keeping the trailing edge it has today.
- **Collapsed (56px)** — **stacked and centred.** 56px minus the rail's own gutters leaves about 32px of
  content box, and two `--height-control` controls cannot sit side by side in it. The collapsed toggle
  already centres itself (`mx-auto w-9 px-0`); Help sits above it on the same axis.

**The trigger takes each container's OWN grammar rather than one shared shape.** In the footer it is a
ghost `Button` with a `h-4 w-4` glyph — what `SidebarToggle variant="footer"` is — so the two controls
beside each other read as one pair. In the strip it is the `ICON_BTN` box `ReportButton` and
`ThemeToggle` use (`--height-control` square, `h-5 w-5` glyph, `--el-text-muted` ink). Making both homes
identical would have made one of them wrong.

### What the menu carries

| #   | Row                    | Glyph       | What it does                                            | Rendered                                  |
| --- | ---------------------- | ----------- | ------------------------------------------------------- | ----------------------------------------- |
| 1   | **Docs**               | `book-open` | anchor — the operator's ABSOLUTE url, `docsIndexUrl()`  | CONDITIONAL — `docsIndexUrl` is non-null  |
| 2   | **Keyboard shortcuts** | `keyboard`  | **button** — opens `ShortcutsCheatsheet`, as `?` does   | always                                    |
| 3   | **Legal documents**    | `scale`     | anchor — the operator's ABSOLUTE url, `legalIndexUrl()` | CONDITIONAL — `legalIndexUrl` is non-null |

**Two of the three are conditional and the FLOOR is one row** — and that floor is the reason the menu is
worth building rather than a reason to doubt it. A self-hosted deployment that has configured neither url
still gets a Help menu, because **Keyboard shortcuts** is unconditional. Nothing marks an absent row: the
rows close up and the menu is shorter, with no disabled row, no tooltip and no empty state — the same line
the rail draws for the same reason.

### Why each conditional row is absent — MOVED here with the rows

Both paragraphs below came from § _The rail's bottom section_, which owned them while the rows lived
there. They are **moved, not copied**: the reasoning describes the ROW, so it belongs wherever the row
is, and a second copy left behind is exactly what this area's divergence ledger exists to prevent.
MOTIR-4254 landed first and removed them from that section, so they stand here and nowhere else.

**The `Legal` row's absent arm has TWO causes, and the second is easy to miss.** `legalIndexUrl()`
derives the index from the configured documents' own urls: if every one is `<base>/<slug>` the index is
`<base>`. An operator publishing at unrelated addresses (`acme.com/terms-of-service`,
`legal.acme.com/privacy`) has no index for the row to point at, so **the row is absent rather than
guessed** — sign-up and the re-consent rows still link each document directly, so nothing becomes
unreachable. A row pointing at the base of SOME of the documents would be worse than no row.

**The `Docs` row reads configuration, and it is the same shape (MOTIR-4167).** The row used to carry a
hard-coded app-relative path to a documentation index that left this repository when MOTIR-3932 moved
the public reading surface to `motir-marketing` — so `app.motir.co/docs` answered **404** while
`motir.co/docs` answered **200**. It was rebuilt around `lib/docs/links.ts`'s `docsIndexUrl()`, which
reads **`MOTIR_DOCS_URL`** — the operator's own ABSOLUTE url — and answers `null` when it is unset, or
when the value is not an absolute `http(s)` url, because a relative path is precisely the defect: it is
refused and logged rather than rendered. **When it is `null` the row is absent**, not disabled and not
dead. `docs/decisions/public-surface-hosts.md` AMENDMENT 2 §D is the record;
`tests/components/HelpMenu.test.tsx` pins both arms of the row (re-homed here from
`SidebarNav-docs-door.test.tsx` by MOTIR-4239, which built this menu) and
`tests/docs/docsLinks.test.ts` both arms of the resolver plus the refusal.

**Row 2 is the one this story ADDS rather than moves, and it is a button, not a link.**
`ShortcutsCheatsheet` is a finished, translated dialog enumerating every global shortcut, and at
`847d44ec9` the only way to open it is to press `?` — a key you find out about by opening the cheatsheet.
It is worse than undiscoverable: `CommandPaletteContextValue` is `{ open, setOpen, openCommandPalette }`
and `cheatsheetOpen` / `setCheatsheetOpen` are local state, so **no surface _could_ offer the door**
without widening that context first. Both GitLab and Plane carry the same row in their help menus.

**Rows 1 and 3 are off-shell targets** — ordinary anchors to absolute urls, **no `active` arm** (this menu
is never on screen at the destination, so `pathname` can never match), no external-link glyph and no
`target`. That is the treatment the rail rows carry today, moved rather than redesigned.

**The label is `Legal documents`, not `Legal`.** `labels.workItemType.legal` is already the string `Legal`
in the same English catalog — the work-item type, meaning _legal work to be done_ — and it renders on
`WorkItemTypeChip`, the type picker and the quick-view panel to the same signed-in user. One word, two
senses; and inside a menu called **Help** the bare noun reads as an offer of legal help. The `zh` catalog
already separates them (`法务` for the work, `法律条款` for the documents); English never did. The
collision itself is filed separately — this asset only stops adding to it.

### The divergence ledger — which source wins for this element

| #   | The other assets say                                                                               | This asset says                                                                                                                                                                                                                          | Since      |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `rail-bottom-section.mock.html`'s revisions before MOTIR-4254 drew `Docs` and `Legal` as rail rows | **Both rows live here now**, and their absent-arm reasoning arrived with them. MOTIR-4254 landed first and removed both from that section; its own ledger row 4 records the move from the other side. **This asset wins for the doors.** | MOTIR-4238 |
| 2   | `top-bar.mock.html` Panel D draws the drawer's utility strip with three controls                   | **Four.** Help leads them. That asset still wins for the drawer's composition and for the bar's control budget; this one wins for the strip's membership.                                                                                | MOTIR-4238 |
| 3   | `desktop.pen` / `desktop-collapsed.pen` draw a footer holding the collapse toggle alone            | **Two controls**, arranged differently at the two widths. Those `.pen` sources cannot be re-exported and are not edited — the same call this area already made for them.                                                                 | MOTIR-4238 |

### Primitives and tokens

**No new primitive and no new token.** The menu is `components/ui/Popover.tsx` (`data-surface="popover"`)
at its own `width={240}`; every row is `UserMenu.tsx`'s treatment — `--radius-control`, `--el-text` ink,
`--el-text-muted` glyph, `--el-surface` hover/focus field. The footer trigger is `components/ui/Button.tsx`
`variant="ghost" size="sm"`; the strip trigger is the `ICON_BTN` string `ReportButton` defines. The rails
are `components/ui/Sidebar.tsx` unchanged. Board chrome routes every colour through `--el-*` and takes
`--el-text-secondary` for body ink rather than `--el-text-muted`, which fails AA on three of the four
surfaces it could land on (`docs/decisions/design-board-chrome-aa.md`).

### How the render was produced

Generated, not hand-drawn, so it cannot drift from the app:

1. The real `Sidebar` is rendered through the repo's own vitest setup at both widths, with the bottom
   section already down to its four remaining rows and the two-control footer in place. The primary
   section is abbreviated context with its real glyphs — `desktop.pen` owns it.
2. The popover shell is Radix's own output, taken from the shipped `UserMenu` opened in the same setup.
3. **The one thing composed rather than rendered is the menu's three rows**, because the component that
   will render them is MOTIR-4239's. They are not hand-written either: each is a rendered `UserMenu` row
   **cloned**, with its href, label and glyph swapped for a real `lucide-react` element. Every row in
   `UserMenu` carries one identical class string, so the clone IS the row treatment.
4. The strip is `SidebarDrawer`'s footer geometry verbatim, holding buttons built from `ReportButton`'s
   own `ICON_BTN` constant.
5. `tailwindcss`'s own `compile()` runs `app/globals.css` (with its two package imports resolved through
   node's resolver) over the assembled markup, so the stylesheet is the build's output.
6. Each frame renders at its own width in one document, so the compiled `@media (width >= …)` blocks are
   re-emitted scoped to `[data-vw="W"]` — `top-bar.mock.html`'s mechanism, a property of the board.
7. **The frames are measured in a browser**, which is what makes the panels' claims checkable rather than
   captioned: every drawn row's box inside its frame, the rail footer asserted to hold **two** controls at
   both widths, and the strip asserted to hold **four** slots with Help leading the three icon buttons.

The generator was a temporary harness and is **deleted with this card's run**.

### What this asset does NOT draw

The **rail's bottom section as a specification** (`rail-bottom-section.mock.html` owns it; the rails here
show it as context, as it stands after MOTIR-4254), the **drawer** itself (`top-bar.mock.html` Panel D), the
**top bar** and its control budget, the **rail head** (`context-row.mock.html`), the **account menu**
(`account-menu.mock.html`), and the `ShortcutsCheatsheet` dialog that row 2 opens — which ships today and
is unchanged by this story.

---

## 3D / Immersive takes the shell chrome — the rail floats, the bar is the lid (MOTIR-4252)

`3d-immersive-shell.mock.html` / `.png` is **the design of record for the app shell under
`data-style="3d-immersive"`**, and the drawing behind
[`docs/styles/3d-immersive.md`](../../docs/styles/3d-immersive.md) §4's new **shell chrome** row and
its **§4b closure rule**. It draws the whole shell — top bar, expanded rail, collapsed rail, main
region — in light and dark, and it draws the **target**: there is no before-frame.

**It is a chrome asset, not a shell-composition asset.** The bar's control budget stays
`top-bar.mock.html`'s, the rail's bottom section stays `rail-bottom-section.mock.html`'s, the rail
head stays `context-row.mock.html`'s and the Help menu stays `help-menu.mock.html`'s. What this
asset owns is the **plane each chrome host sits on**, and nothing else about them.

### Why the area owed this

**§4's plane ladder named ten surfaces and stopped before the frame.** It has rows for modal,
popover, card, board card, page panel, board column, button, quiet control/row, text field and
status pill — and none for the top bar or the rail. The stylesheet matched the spec exactly: the
`[data-style='3d-immersive']` block in
[`packages/design-system/theme.css`](../../packages/design-system/theme.css) carried **no
`[data-surface='header']` rule and no `[data-surface='sidebar']` rule**, while both hooks are emitted
([`app/(authed)/_components/TopNav.tsx`](<../../app/(authed)/_components/TopNav.tsx>),
[`components/ui/Sidebar.tsx`](../../components/ui/Sidebar.tsx)) and **five of the eleven styles
already use them**:

| Style            | `[data-surface='sidebar']`                | `[data-surface='header']` |
| ---------------- | ----------------------------------------- | ------------------------- |
| glassmorphism    | ✅ frosted chrome over the canvas         | —                         |
| aurora           | ✅ the aurora sheen                       | —                         |
| hand-drawn-indie | ✅ a wavy right edge                      | ✅ a wavy bottom edge     |
| neumorphism      | ✅ moulded, raised, + both a11y fallbacks | —                         |
| retrofuturism    | ✅ chrome bevel + specular                | —                         |
| **3d-immersive** | **none**                                  | **none**                  |

**So the frame rendered byte-identically to the default style's**, and §4 contradicted itself as a
result: its _Quiet control / row_ row says a sidebar nav link is _"flat at rest… **the surface they
sit in is what floats**"_. The surface it sits in did not float, was not specified to float, and had
nowhere on the ladder to be told to.

**And this is the reason the card was a re-shape rather than a third patch.** Three defects have now
been filed against this one style and all three are one shape — _a promise bound to an enumeration,
with silence where the enumeration ends_: MOTIR-3522 (199 of 280 controls flat, the physical-key rule
enumerating two radius utilities), MOTIR-4230 (the atmosphere painted on `body` alone, so the shell
root covered it), MOTIR-4253 (the chrome never enumerated at all). 3522 fixed the mechanism **for
controls** — that fix is §4a and `tests/theme/immersive-control-depth.test.ts` — and left it standing
one level up, over SURFACES. §4b is that fix for surfaces, and it is the part of this work that
outlives the drawing.

### The decision — four dispositions ship in real design systems and they conflict

The verdict is that **the two chrome hosts take DIFFERENT planes**, and the ladder gains one row that
says which. They are two objects: the rail is a panel with an edge, the bar is a lid content stops
beneath.

| Disposition                                                                                                                                      | Verdict                                                             | The argument                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chrome as GROUND** — Fluent 2 / Windows 11 (Mica, Acrylic are _"base layers beneath interactive UI"_); M3's top app bar at rest at elevation 0 | **REJECTED**                                                        | It contradicts §4's own _Quiet control / row_. Adopting recede means amending that row to say the rail is flat — and its rows are already flat by the ladder, so the frame becomes the one region of the app with no depth anywhere, which is §8's half-3D failure at the largest scale on the screen. Fluent's recede is coherent because its depth is a **material that occludes**; this style's depth is **geometry**, and geometry can only say _beneath_ by not floating, which here reads as _unstyled_.                         |
| **Chrome as REACTIVE ground** — M3's actual mechanic: level 0 → level 2 only when content scrolls beneath                                        | **REJECTED — and this is the card's own recommendation, falsified** | Measured, not assumed. [`components/ui/AppLayout.tsx`](../../components/ui/AppLayout.tsx) is `h-dvh overflow-hidden` and `<main>` is the shell's ONLY scroller (MOTIR-3208); the bar sits in a `shrink-0` row **above** that grid, outside the scroller. **Nothing passes under this bar.** Its `sticky top-0` earns its keep on the public and auth surfaces, where the document scrolls — in the signed-in shell it is inert. The event M3 keys on never occurs beneath this bar, so the lift would be depth with nothing behind it. |
| **Chrome as ORNAMENT** — visionOS toolbars and tab bars, floating in front on the z-axis on a glass capsule, overlapping the window edge         | **REJECTED**                                                        | An ornament overlaps its window, and `AppLayout` composes the rail as a **grid column**. So this is not a treatment, it is a layout change from grid to overlay with the main region reserving a footprint — and [`docs/DESIGN.md`](../../docs/DESIGN.md)'s two-axis contract says a style sets shape and feel, not the shell's architecture. Its glass capsule is also Glassmorphism's material, and `theme.css`'s own header states the differentiator: _glass is a translucent MATERIAL over a gradient; 3D is OPAQUE depth_.       |
| **The floating / inset panel** — the web shorthand: shadcn's `floating` and `inset` sidebar variants, Slack, Linear                              | **ADOPTED, for the RAIL only**                                      | It is the one disposition that makes §4's existing promise **true** instead of amending it away, and it composes with what MOTIR-4230 shipped: an inset rail only reads as inset because there is an atmosphere behind it, and that card is what put the atmosphere on the shell root.                                                                                                                                                                                                                                                 |

**What ADOPTED means for the BAR, said plainly: it takes none of the four.** It is not ground (it
lifts), not reactive (there is no scroll beneath it), not an ornament (it does not overlap), and not
a panel (it keeps full-bleed edges and square corners). **The lid is the fifth answer, and it is the
one the shipped shell makes available.**

**Why the bar takes the ladder's LOWEST rung and the rail the card rung** — the distinction that
keeps the two-plane story honest rather than arbitrary. **How far a surface floats is how far you can
see under its edges.** The rail has four edges in the scene, so it can be an object at a distance:
`--shadow-card`. The bar has exactly one — its bottom — so the only thing it can express is a
CONTACT: _this edge is where the region below begins_. That is `--shadow-subtle`, the ladder's
tightest rung. A bar wearing `--shadow-card` would out-float the panel it frames, on the strength of
one visible edge.

**The card's own recommendation was half right and is amended on the record.** It named _"rail →
floating/inset panel, header → the on-scroll lift"_. The rail half is adopted verbatim. The header
half is rejected on a measurement the card did not have, and the amendment is recorded here and on
the card rather than dropped silently.

### The rules — what MOTIR-4253 ships

These are the rules the frames in the asset are **drawn by**, injected verbatim into the mock's own
`<style>` so a frame cannot flatter a rule the implementation could not write. They go in the
`[data-style='3d-immersive']` block of `packages/design-system/theme.css`.

```css
:root {
  --spacing-rail-inset: 0px;
}

[data-style='3d-immersive'] {
  --spacing-rail-inset: 10px;
}

@scope ([data-style='3d-immersive']) to ([data-style]) {
  /* The RAIL — a floating panel. */
  [data-surface='sidebar'] {
    margin: var(--spacing-rail-inset);
    height: calc(100% - 2 * var(--spacing-rail-inset));
    border-radius: var(--radius-card);
    border-right-color: transparent;
    box-shadow: var(--shadow-card);
  }
}

@scope ([data-style='3d-immersive']) to ([data-style]) {
  /* The TOP BAR — the LID. */
  [data-surface='header'] {
    background-color: transparent;
    border-bottom-color: transparent;
    box-shadow: var(--shadow-subtle);
  }
}

@media (prefers-contrast: more) {
  @scope ([data-style='3d-immersive']) to ([data-style]) {
    [data-surface='sidebar'] {
      outline: 1px solid var(--el-border-strong);
      outline-offset: -1px;
    }
    [data-surface='header'] {
      border-bottom-color: var(--el-border-strong);
    }
  }
}

@media (forced-colors: active) {
  @scope ([data-style='3d-immersive']) to ([data-style]) {
    [data-surface='sidebar'] {
      outline: 1px solid var(--el-border-strong);
      outline-offset: -1px;
      box-shadow: none;
    }
    [data-surface='header'] {
      border-bottom-color: var(--el-border-strong);
      box-shadow: none;
    }
  }
}
```

**Four things in that block are decisions rather than syntax:**

1. **`box-shadow` ONLY on the bar, never `position`.** `hand-drawn-indie` carries the guard
   explicitly — the sticky header is already a containing block and overriding it breaks the sticky —
   and the pleasing part is that the same property is what makes the lid work: `sticky … z-30`
   creates the **stacking context** that lets the shadow paint over the region beneath it. A static
   header's downward shadow is painted behind the next sibling's background and is invisible. **The
   constraint and the mechanism are the same line of the component.**
2. **The rail's shared edge goes `border-right-color: transparent`, not `border: none`.** The 1px
   stays in the box, so `--width-rail-chrome` — the rail's `px-2` gutters plus that border — is
   unchanged. A floating panel has a shadow instead of a shared edge; it does not have a different
   width.
3. **Both fallbacks restore a LINE the treatment made transparent, and neither moves a pixel.** The
   rail's hairline comes back as an `outline` with `outline-offset: -1px` — drawn outside the box,
   follows the radius, costs no layout — and the bar's `border-bottom` already has its width; only
   its colour was taken away. This is `neumorphism`'s pattern (its own `prefers-contrast: more` /
   `forced-colors: active` blocks) applied to a treatment whose structure rests on a shadow.
4. **`--spacing-rail-inset` is `0px` in the base layer.** Every other style is untouched and the
   `AppLayout` sums below compile to today's numbers everywhere else, which is what makes this a
   style-axis change rather than a shell change.

### The geometry the implementation inherits — an inset rail moves a column

**The rail fills its grid cell, so a margin shrinks the RAIL, not the cell — and the collapsed rail
cannot shrink.** Its content box is exactly one `--height-control` square, which is why MOTIR-4232
made that column a SUM rather than a constant. So the **column** grows by twice the inset, in both
states, and the main region gives up that width.

| Column                | Today                                                    | With the inset                                                                           | At this style's tokens                      |
| --------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Collapsed rail**    | `calc(var(--height-control) + var(--width-rail-chrome))` | `calc(var(--height-control) + var(--width-rail-chrome) + 2 * var(--spacing-rail-inset))` | 40 + 20 + 20 = **80px** (60px today)        |
| **Expanded rail**     | `240px`                                                  | `calc(240px + 2 * var(--spacing-rail-inset))`                                            | 240 + 20 = **260px**                        |
| **Every other style** | unchanged                                                | the same expression                                                                      | `--spacing-rail-inset: 0px` → **unchanged** |

The two class strings [`components/ui/AppLayout.tsx`](../../components/ui/AppLayout.tsx) carries
become:

```
md:grid-cols-[calc(var(--height-control)_+_var(--width-rail-chrome)_+_2_*_var(--spacing-rail-inset))_1fr]
md:grid-cols-[calc(240px_+_2_*_var(--spacing-rail-inset))_1fr]
```

**This is stated here because a card that only reads the CSS block would not find it.** Insetting is
a stylesheet change everywhere except the one place it is a component change, and the component is in
a different repository area from the token block.

### The CLOSURE RULE — the part that outlives this asset

The rule lives in [`docs/styles/3d-immersive.md`](../../docs/styles/3d-immersive.md) §4b, not here,
because it governs the SPEC. Its short form: **every surface class the app renders is either assigned
a plane or listed as deliberately flat with a named reason; a surface class absent from the ladder is
a spec defect, not a default.**

Two rows in that table carry a reason rather than a plane, and they are the proof the rule is not
just a longer list — a closure rule with no flat rows is only a demand that everything float:

- **The modal scrim** (`[data-surface='overlay']`) — a scrim is the absence of a surface, not one.
  Its job is to remove the plane behind the modal; a plane of its own puts a floating sheet between
  the modal and the page it is dimming.
- **The specimen page** (`[data-surface='page']`,
  [`packages/design-system/src/specimen/TokensSpecimen.tsx`](../../packages/design-system/src/specimen/TokensSpecimen.tsx))
  — a page ABOUT surfaces rather than one of them. Floating the host would put a plane between the
  reader and what they are reading.

### Primitives and tokens

**No new primitive, no new colour token, and one new SHAPE token.** Every colour in the rules is an
existing `--el-*` (`--el-border-strong`) or an existing style-axis shadow token
(`--shadow-card`, `--shadow-subtle`); every shape is an existing element-semantic token
(`--radius-card`) except `--spacing-rail-inset`, which is added to the base layer at `0px` and moved
only by this style — the per-component growth pattern the shape rule prescribes. **The chrome hosts
are unchanged components**: `Sidebar` and `TopNav` keep their class strings exactly as they ship, and
the treatment reaches them entirely through the two `data-surface` hooks they already emit.

Board chrome routes every colour through `--el-*` and takes `--el-text-secondary` for body ink rather
than `--el-text-muted`, which fails AA on three of the four surfaces it could land on
([`docs/decisions/design-board-chrome-aa.md`](../../docs/decisions/design-board-chrome-aa.md)).

### The access path

**None, deliberately — and that is a finding rather than an omission.** This asset adds no
affordance, no destination and no new surface: it changes the plane two existing hosts sit on. There
is no door to draw, and drawing one would mean inventing a control the shell does not need. The
surfaces it depicts are reached exactly as they are today — the shell is what you are already
looking at on every signed-in route.

### The divergence ledger — which source wins for this element

| #   | The other assets say                                                                                                                                                                                      | This asset says                                                                                                                                                                                                                                                                                                                | Since      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | Every other shell asset draws the rail with a **shared right border**, flush to the viewport edge, and the bar with an opaque fill and a hairline                                                         | **Under `data-style="3d-immersive"` only**: the rail is inset and floating, the bar has no fill and no hairline. Those assets draw the DEFAULT style and remain correct for it — **this asset wins for one style axis value and claims nothing about the other ten.** A style-scoped asset does not supersede an unscoped one. | MOTIR-4252 |
| 2   | `top-bar.mock.html` owns the bar's control budget; `rail-bottom-section.mock.html` owns the rail's rows; `context-row.mock.html` owns the rail head; `help-menu.mock.html` owns the footer's two controls | **All four still win for their own element.** This asset LIFTS their output as context and re-specifies none of it. Its subject is the plane, and only the plane.                                                                                                                                                              | MOTIR-4252 |
| 3   | `docs/styles/3d-immersive.md` §4's _Quiet control / row_ said the surface a sidebar nav link sits in is what floats — of a surface no rule made float                                                     | **The premise is now TRUE**, and that row is unchanged because it never needed changing: what was missing was the rule underneath it.                                                                                                                                                                                          | MOTIR-4252 |

### How the render was produced

Generated, not hand-drawn, so it cannot drift from the app. Reproduced inline rather than cited,
because the harness is deleted with this card's run:

1. **The RAILS are lifted from `help-menu.mock.html`**, whose two rails are the real
   `components/ui/Sidebar.tsx` rendered through the repo's own vitest setup, drawn after MOTIR-4254
   cut `Docs` and `Legal`: **four bottom rows** — Settings · Security · Job runs · Git — and the
   **two-control footer** MOTIR-4238 added. Lifted with a real HTML parser (`happy-dom`) via
   `[data-vw="240"] nav[data-surface="sidebar"]` and `[data-vw="56"] …`, never string surgery.
2. **The TOP BAR is lifted from `account-menu.mock.html`'s `[data-vw="1024"]` frame**, which is
   `top-bar.mock.html`'s bar with MOTIR-4248's corrected `--height-control`-square avatar already
   substituted. **Its class string is restored to `TopNav.tsx`'s shipped one** — that asset drew bars
   alone and dropped `sticky top-0 z-30`; this one draws the SHELL, where the stacking context those
   classes create is exactly what makes the lid's shadow paint.
3. **The MAIN region's panels are the real primitives** — `Card`, `Button`, `Pill`, `SectionLabel` —
   rendered through [`tests/helpers/renderWithIntl.tsx`](../../tests/helpers/renderWithIntl.tsx) in a
   throwaway spec under a throwaway config (`environment: 'happy-dom'`, no `globalSetup`, the `@` and
   `server-only` aliases), dumped as `container.innerHTML`.
4. **The frames are `AppLayout`'s own structure and class strings**, with `h-dvh` overridden by an
   inline height (a frame is a picture of a viewport) and `id="main"` dropped (the board holds six
   shells and an id is unique per document).
5. **`tailwindcss`'s own `compile()` runs `app/globals.css`** — with its package imports resolved
   through node's resolver — over the assembled markup, so the stylesheet is the build's output
   rather than a retyped token block.
6. **The axis attributes go on a WRAPPER around the shell root, because `<html>` carries them in the
   app — and that is load-bearing rather than tidy.** `theme.css`'s atmosphere rule is
   `@scope ([data-style='3d-immersive']) { body, [data-app-shell] { … } }`, and inside an `@scope` a
   bare selector matches a DESCENDANT of the scope root. Put `data-style` on the shell root itself and
   `[data-app-shell]` **is** the root, matches nothing, and the frame renders with **no atmosphere at
   all** — while every other rule still fires, which is what makes the omission invisible. The first
   render of this asset had exactly that bug; `getComputedStyle(shell).backgroundImage` returning zero
   `radial-gradient` layers is what found it, not looking at the picture.
7. **Two blocks are re-emitted UNLAYERED, and the reason is a CSS-engine fact worth
   carrying.** Tailwind v4 puts the Tier-0 palette inside `@layer theme`, and `theme.css`
   declares the Tier-3 `--el-*` layer BELOW its first `@scope` at-rule. A cascade-layer-blind
   engine drops the first, and a parser that stops at `@scope` drops the second — so under the
   design lane's happy-dom guards **every tailwind-compiled asset in this tree reads
   `--el-page-bg` as unset**, while being perfectly live in a browser. (The tell is exact:
   `--color-background` resolves, because the dark Tier-0 flip sits ABOVE the first `@scope`;
   `--el-page-bg` does not.) Both blocks are therefore lifted — the compiler's own declarations and
   the file's own declarations, never retyped — into a leading `<style>`, with `[data-theme]`
   added to the Tier-3 selector list so a NESTED dark scope recomputes the layer against its own
   Tier-0. **The lift strips the source's prose comments**, which document `theme.css` rather than
   this asset — and one of them names a `lib/projects/` module that no longer exists, which
   the design lane's address guard correctly failed the moment it was carried into `design/**`. That
   the guard cannot see the comment in its own home is a separate finding, filed rather than fixed
   here. It is inert in a browser: the values are identical and every unlayered
   override in `theme.css` still comes later and still wins. **This asset is the first
   tailwind-compiled mock in the tree with a nested dark scope, which is why the gap surfaced
   here** — `design/settings/two-factor.mock.html` hit the second half of it and wrote its Tier-3
   copy by hand (MOTIR-3712). What the lift buys beyond a green lane is that the ink-contrast
   guards, which also render in happy-dom, can now RULE on this asset instead of abstaining on
   tokens they cannot resolve.
8. **One value is restored rather than compiled: `--width-rail-chrome`.** It is an `@theme` variable
   consumed only by a `calc()` inside `AppLayout`'s grid utility, which no utility in this board's
   markup emits — so Tailwind tree-shakes it, the collapsed column's sum becomes invalid, and the grid
   silently falls back to one column. The generator READS the declaration out of `theme.css` rather
   than retyping it, so it cannot drift.
9. **The proposed rules are injected verbatim**, so the frames are drawn BY them.
10. **The frames are measured in a browser**, which is what makes the panels' claims checkable rather
    than captioned. All six frames: the atmosphere resolves to **3 radial-gradient layers**; the rail's
    inset is **10px on all four sides**; the rail's radius is **20px** (`--radius-card` at this style);
    the expanded rail is **240px** in a **260px** column and the collapsed rail **60px** in an **80px**
    column, so `mainColStart` is 260 and 80; the bar's computed `background-color` is
    `rgba(0, 0, 0, 0)` and its `border-bottom-color` transparent, with `position: sticky` and
    `z-index: 30`; **zero** drawn rail elements lie outside their frame; the expanded rail's bottom
    section holds **four** rows and its footer **two** controls. The two fallback frames measure
    `outline: solid rgb(200, 196, 190)` (`--el-border-strong`) with the bar's border restored, and the
    `forced-colors` frame measures `box-shadow: none` on both hosts.
11. **A board property, stated so it is not read as an app one**: the immersive background is
    `background-attachment: fixed`, which resolves against the real viewport — correct in the app,
    where the shell IS the viewport, and wrong on a board holding six shells, where every frame would
    show a slice of one giant gradient. The board resolves it against each frame's own box instead.

### The design-allocation sweep — what this asset GIVES and TAKES

| Card                                                                                                    | GIVES / TAKES | What                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4253** (the implementation, `blocked_by` this card)                                             | **GIVES**     | The two `data-surface` rules verbatim, both a11y fallback blocks, the `--spacing-rail-inset` token and its `0px` base, and the two `AppLayout` class strings. It also gives it the §4b closure rule to satisfy, which is scope its estimate did not carry. |
| `rail-bottom-section.mock.html` · `top-bar.mock.html` · `context-row.mock.html` · `help-menu.mock.html` | **NEITHER**   | Their elements are lifted as context and re-specified nowhere. Nothing is taken away from them and nothing added.                                                                                                                                          |

### What this asset does NOT draw

The **bar's composition** or its control budget (`top-bar.mock.html`), the **rail's rows**
(`rail-bottom-section.mock.html`), the **rail head** (`context-row.mock.html`), the **Help menu** and
the **account menu** (their own assets), the **mobile drawer** below `md` — the rail is
`hidden md:block` and the drawer takes over, and a drawer is an overlay rather than a chrome host, so
it is out of the ladder's shell-chrome row — the **platform-admin shell**
([`app/(admin)/_components/AdminShell.tsx`](<../../app/(admin)/_components/AdminShell.tsx>)), which
carries the same `data-app-shell` hook and therefore inherits the atmosphere but has no
`data-surface` chrome of its own, and the **other ten `[data-style]` values**, whose chrome this
asset makes no claim about.

## The no-project shell (MOTIR-6540)

**Story MOTIR-6169 · design card MOTIR-6540 · built by MOTIR-6548.** A delta of `top-bar.mock.html`,
drawn in **`design/shell/no-project--limited.mock.html`** (panels S1–S4). The shared vocabulary and the
GIVES / TAKES are in `design/projects/design-notes.md` § _Access modes at the project (MOTIR-6540)_.
Rendered first against `/items` and the top bar's project switcher at `origin/main` @ `c6cf7e5b4`.

**Why it exists.** MOTIR-4815 made "you are always in a project" true, and MOTIR-4872 retired every
no-project surface. That premise holds only while every member can open every project. A **Limited**
member added to no project can open NOTHING in a workspace that has projects — `home-scope.md` §1's
zero-projects frame, live again for one actor. This is that one state. It is **not** the retired
create-first screen: its create door shows only to someone allowed to create a project.

**Access path.** It is a landing, not a place you navigate to: the destination
`lib/navigation/landing.ts` resolves after sign-in and after a workspace switch, and what every
project-scoped route renders while there is no active project.

### Panels

- **S1 — the landing.** The top bar keeps the workspace switcher; the project crumb reads an italic
  _No project_ (`--el-text-secondary`). The top bar's **Create** (a work item, into the active project)
  is **not rendered** — there is no project to create into. The rail is the shipped rail; every
  project-scoped row lands on this same shell. The home area is the shipped `EmptyState` (`Card`,
  `FolderKanban` 48px in `--el-icon-muted`, serif title, `--el-text-secondary` body).
- **S2 — the switcher opens on an empty list.** The shipped popover (_PROJECTS_ mono label) with one
  sentence where rows would be, and no _Create project_ row. Still a labelled listbox.
- **S3 — someone who MAY create projects.** _Create project_ returns to the switcher and the empty state
  gains a primary **Create a project**. Shown only with the create permission.
- **S4 — dark.**

### Copy — `shell.noProject.*` (new; en + zh)

| key (proposed)  | en                                                                                        | zh                                                                       |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `crumb`         | No project                                                                                | 无项目                                                                   |
| `title`         | You’re not in a project yet                                                               | 你尚未加入任何项目                                                       |
| `body`          | A Manager of {workspace} can add you to a project. You’ll see it here as soon as they do. | {workspace} 的管理者可以将你添加到项目中。一旦添加，你就会在这里看到它。 |
| `switcherEmpty` | You haven’t been added to a project in {workspace} yet.                                   | 你尚未被添加到 {workspace} 的任何项目。                                  |
| `create`        | Create a project                                                                          | 创建项目                                                                 |

### Tokens &amp; a11y

`--el-*` only; `--radius-card/-control/-btn`, `--height-control`, `--shadow-card/-elevated`. The empty
switcher is a `listbox` with `aria-label` _Projects_ and a text child, so it announces as empty rather
than as nothing. `tests/navigation/no-create-project-screen-guard.test.ts` must stay green: this shell
is not a create-first screen.

## The server-error page (MOTIR-6854)

**Bug MOTIR-6776 · design card MOTIR-6854 · built by MOTIR-6855.** A NEW surface, drawn in
**`design/shell/server-error.mock.html`** (panels 1, 1a, 1b, 2, 3 and the dark board D1–D3). It
composes the shipped `ErrorState`, `Card` and `Button` (`packages/design-system`) and the shell as
`no-project--limited.mock.html` draws it, read at `origin/main` @ `4495c493f`.

**Why it exists.** `app/` has exactly two `error.tsx` files, both on settings panes
(`app/(authed)/settings/project/{components,fields}/error.tsx`), and no `global-error.tsx`. So a
server render failure anywhere else reaches Next's `onUncaughtError` and the reader is left with an
empty tab. On 2026-09-28 a P2028 transaction stall in `app/(authed)/layout.tsx:227`
(`projectsService.listProjects`; server event MOTIR-6780, cause owned by MOTIR-6788) produced exactly
that on `/workbench`. This page is what the reader sees instead, whatever made the server fail.

**Access path.** There is no door to draw: any navigation, and any refresh or cold load, can land
here. Panel 2's address strip draws the one arrival that is not a click — a hard reload of a URL
whose render fails lands on this page on the first paint.

### Three depths, three boundaries

A segment's `error.tsx` wraps that segment's CHILDREN, never its own layout, so each depth needs its
own boundary, and each renders inside a different amount of chrome:

| state                              | thrown in                                                                                  | caught by                | chrome around it                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------ |
| **1** — a page failed              | any page under `app/(authed)/`                                                             | `app/(authed)/error.tsx` | the full shell: top bar + rail                   |
| **2** — the signed-in shell failed | `app/(authed)/layout.tsx` (today's event)                                                  | `app/error.tsx`          | root layout only: tokens + locale, no shell      |
| **3** — the root failed            | `app/layout.tsx` (it reads `appearancePreferenceService.getApplied` per signed-in request) | `app/global-error.tsx`   | nothing — it renders its own `<html>` / `<body>` |

### Panels

- **1 — in the shell.** The content area holds the shipped **`ErrorState`** as it composes today —
  `Card` with `role="alert"`, `AlertTriangle` 48px in `--el-danger`, serif `text-xl` title,
  `--el-text-muted` body **on the white card** (4.54:1, its one safe surface), and its secondary
  **Try again** (`common.retry`). Centred in the content column at the width (480px) and top padding
  (72px) the no-project shell's home area uses. **No second door:** the rail and top bar are the way
  out — the reasoning `app/(authed)/not-found.tsx` already rests on.
- **1a — Retry pending.** Try again takes the shipped `Button`'s `loading` state: `Spinner`,
  `disabled`, `aria-busy`, label **Trying again…**. Nothing else on the page moves.
  ⚠️ **`ErrorState` does not expose this today**: its retry `Button` takes no `loading`. The build
  adds one optional prop to `ErrorState` (e.g. `retryPending`, passed to that `Button` with its
  pending label) rather than hand-composing a second copy of the card.
- **1b — Retry failed again.** The same page: no second card, no stacked message, no attempt count, no
  loop. Only the **reference** changes, because a new failure carries a new digest. Drawn just after
  **Copy reference**: the button becomes a quiet **Copied** (`role="status"`) for 2 s, then returns.
- **2 — the signed-in shell failed.** A full page like `app/not-found.tsx` (centred, `max-w-[48rem]`,
  `min-h-dvh`), the same `ErrorState` with the app-level copy. With no shell the page owes a door of
  its own: **Go to Motir** — the existing `errors.notFound.homeAction` key, reused — a link to `/`,
  which already sends a signed-in reader to its landing, `/workbench`, and anyone else to `/sign-in` (`app/page.tsx`).
- **3 — the root failed.** **The same page as state 2**, drawn on the default appearance. Go to Motir
  still goes to `/`: this page cannot know whether the reader has a session, and `/` is the one
  address that decides it.
- **D1–D3 — dark.** The three states on the dark board.

### The reference (the digest)

**Shown.** Below the card, on the page ground: `Reference` + the error's `digest` in a mono chip
(`user-select: all`) + an icon button **Copy reference**. It is what a reader can quote to support,
and the same value the boundary tags its Sentry report with, so support can find the matching server
event. A digest is Next's opaque hash of the server error — it carries no message and no data, which
is why it is safe to show. **When `error.digest` is absent** (an error thrown in the browser, which
has none), the whole line is not rendered. The chip is on `--el-surface`, so its ink is
`--el-text-secondary`, never muted.

### What state 3 loses, and how each is replaced (for MOTIR-6855)

`global-error.tsx` REPLACES `app/layout.tsx`, so everything the root layout supplies is absent:

- **The appearance.** No server `data-theme` / `data-palette` / `data-style` / `data-type` on
  `<html>` — the server preference is the database read that may be what failed. The page runs the
  same theme init script with **no server preference** (`buildThemeInitScript(null)`), which reads
  this device's stored appearance — kept reconciled from the server on every signed-in page — and
  resolves `system` through `matchMedia`. So the page honours the reader's appearance **as last seen
  on this device**; what it cannot honour is a change made on another device and not yet seen here.
  With nothing stored it renders the default appearance, drawn in panel 3. **Ink and ground come
  from ONE authority**: both are `--el-*` under the one `data-theme` the script sets, never ink from
  `prefers-color-scheme` over a ground from `data-theme` — the split that made MOTIR-4708's 404
  1.00:1.
- **The fonts.** The root layout puts the `next/font` variables on `<html>`; `global-error` must apply
  the same classes to its own `<html>`, or the serif title falls back to Georgia.
- **The translations.** It renders outside the `next-intl` provider, so its strings cannot come from
  `messages/*.json` through `useTranslations`. It carries its own small `en` / `zh` catalog of the
  keys below, chosen from `NEXT_LOCALE` (the cookie `i18n/request.ts` reads) or `navigator.language`,
  falling back to `en`.

### Copy — `errors.serverError.*` (new; en + zh), plus two reused keys

| key                                     | en                                                                                                                                                                                                              | zh                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pageTitle`                             | This page couldn’t load                                                                                                                                                                                         | 此页面无法加载                                                                                                                        |
| `pageBody`                              | Something went wrong on Motir’s side while loading it — nothing you did caused this. Try again; if it keeps happening, include the reference below when you contact support.                                    | 加载此页面时 Motir 这边出现了问题，这不是你的操作导致的。请重试；如果问题持续出现，联系支持时请附上下方的参考编号。                   |
| `appTitle`                              | Motir couldn’t load                                                                                                                                                                                             | Motir 无法加载                                                                                                                        |
| `appBody`                               | Something went wrong on our side before this page could open — nothing you did caused this. Try again, or go back to Motir’s home. If it keeps happening, include the reference below when you contact support. | 页面打开之前，我们这边出现了问题，这不是你的操作导致的。请重试，或返回 Motir 首页。如果问题持续出现，联系支持时请附上下方的参考编号。 |
| `retrying`                              | Trying again…                                                                                                                                                                                                   | 正在重试…                                                                                                                             |
| `reference`                             | Reference                                                                                                                                                                                                       | 参考编号                                                                                                                              |
| `copyReference`                         | Copy reference                                                                                                                                                                                                  | 复制参考编号                                                                                                                          |
| `copied`                                | Copied                                                                                                                                                                                                          | 已复制                                                                                                                                |
| _(reused)_ `common.retry`               | Try again                                                                                                                                                                                                       | 重试                                                                                                                                  |
| _(reused)_ `errors.notFound.homeAction` | Go to Motir                                                                                                                                                                                                     | 前往 Motir                                                                                                                            |

State 1 uses `pageTitle` / `pageBody`; states 2 and 3 use `appTitle` / `appBody`. The copy names no
cause — the page only knows that the server failed — and never blames the reader.

### Tokens &amp; a11y

`--el-*` only: `--el-danger` (the triangle, a graphic), `--el-text` / `--el-text-muted` (on the white
card) / `--el-text-secondary` (the reference line, on any ground), `--el-link`, `--el-surface` +
`--el-border` (the digest chip), `--el-button-border`. Shape: `--radius-card`, `--radius-btn`,
`--radius-control`, `--height-btn-md`, `--spacing-card-padding`, `--spacing-tooltip-x/y` (the chip).
`ErrorState`'s `role="alert"` announces the failure; the copy button has an `aria-label` and its
confirmation is a `role="status"`.

### What this page does NOT cover

- **A server ACTION's failure** — a click whose `POST` returns 500 (MOTIR-6147's comments). That is a
  toast or inline message on the component that fired it, not a page.
- **A 404.** `notFound()` is not an error to these boundaries; the two not-found pages stay the answer.
- **The two settings-pane boundaries** keep their own panels. They already compose the same
  `ErrorState`, so they read as the same family; this design changes neither.
- **Why the server failed** — that is MOTIR-6788's.
