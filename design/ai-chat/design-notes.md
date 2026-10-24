# AI chat / onboarding — design notes

Design reference for the `ai-chat` UI area — **Motir's start-fresh onboarding
journey** (Story 7.3, `MOTIR-804`). The single, comprehensive
**screen-by-screen** design of the flow, reviewable before any UI is built.

> **Revised to the gated, conversation-only model (subtask 7.3.68 /
> `MOTIR-1100`, 2026-06-18).** This asset began as `7.3.44` / `MOTIR-1061`;
> `MOTIR-1100` brings it onto the FINALIZED model and is now the source of truth.
> Everything `1061` got right is kept (canvas roadmap + chat rail, full-screen
> per-tier review, validate-first ask, the design step styling its whole self,
> the feature catalog folded into vision). What changed: **(1)** all inline doc
> editing is REMOVED — the docs are READ-ONLY and the chat is the sole input;
> **(2)** the per-tier **Continue gate + conductor narration** is drawn; **(3)**
> the **downstream-only cascade / back-navigation** + "nothing locked until
> generate" is drawn.
>
> **Grounded in the workflow-defining subtasks** (the design-content dependency
> rule — design TO the spec, never invent the flow): the **conductor**
> `7.3.67`/`MOTIR-1099` (one prompt drives the whole gated conversation:
> ask → draft-tier(ready) → narrate → classify-impact across the DAG), the
> **gated step machine** `7.3.9`/`MOTIR-838` + `7.3.23`/`MOTIR-1036` (per-tier
> gates, dependency-closed skips, catalog folded into vision), the **read-only
> gates** `7.3.5`/`MOTIR-833` + `7.3.6`/`MOTIR-834` (Continue / Skip + chat-only,
> cascade-back re-review, NO edit affordance), the **re-derivation engine**
> `7.3.24`/`MOTIR-1037` (downstream-only coordinated re-derivation), the
> **validate-first** ask `7.3.47`/`MOTIR-1064`, and `workflow.html` Steps 1-6.
> Supersedes the cancelled wizard designs `7.3.26`/`MOTIR-1039` +
> `7.3.43`/`MOTIR-1060`.

---

## ⭐ The model — the canvas IS the roadmap; the chat is a right rail

The whole flow is **one frame with two modes**:

1. **The hub = a visual CANVAS (left) + a CHAT (compact right rail).** The canvas
   is **one continuous roadmap** — _another form of display of the work-item tree
   **+** the pre-plan phase_: **Idea → Discovery → Vision → Feasibility →
   Validation → Plan → Epic 1 → Epic 2 → …**, each epic expandable to its
   **stories → subtasks**. It shows **where you are** the whole way through (with
   descriptive station names, not jargon). The **chat drives** the active step; it
   never takes the screen.
2. **A step takes the FULL SCREEN** — a READ-ONLY write-up to review, or the design
   step — with a plain **"Back"** button (no internal words like "canvas") and a
   **descriptive** header (`Pre-plan · building your direction`, not a row of
   meaningless short words and never "doc N of 4"; the journey lives on the canvas).

**Labels are PLAIN LANGUAGE, never jargon** — a founder won't know "Feasibility"
or "Validation". The four pre-plan docs read: **"Understanding your idea"** ·
**"What we'll build"** · **"Is it worth building?"** (optional) · **"Will people
want it?"** (optional). Each is **shown READ-ONLY** at its own review gate, then an
explicit **Continue** advances to the next tier. **There is NO inline editing
anywhere** — you react ONLY in the chat, and the conductor revises the write-up for
you (`7.3.5` / `7.3.6`). The two optional ones are **skipped in the CHAT** (before
they generate), never on the doc. Validation can be **front-loaded** (validate
demand first). The conductor **drives the flow** (proceeds on its own; Skip cancels
an upcoming optional tier). The design step **styles its whole self**. (All
detailed below.)

**The gated rhythm** (the model's spine — see §"The gate rhythm"): the conductor
DRAFTS a tier → you review it READ-ONLY → you press **Continue** → the conductor
**NARRATES** the handoff in the chat ("I have enough — drafting what we'll build
now") → it drafts the next tier. **Nothing is locked until epic generation** (the
single commit) — every Continue is **navigation, not sign-off**. A chat reaction
the conductor attributes to an **upstream** tier sends you **back** to re-review
that tier, then forward; downstream tiers re-derive. **Cascade is downstream-only.**

This keeps what the prior drafts got right: the canvas-left + chat-right layout
(the chat never dominates), progress **on the canvas** (visual + descriptive), the
roadmap **continuing past Plan** into the epics/stories (the same canvas, a view of
the work-item tree), the **skip as a chat decision**, and the design step as the
example **at full page scale** — and corrects them to the conversation-only,
gated model above.

---

## The screens (in journey order)

| #      | Screen                                    | What it is                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B**  | **Public landing**                        | the idea prompt **+ the workflow preview**: the **3 mandatory steps** (Understanding your idea · What we'll build · Your plan/build) shown as descriptive blocks, with a **click-to-expand** bar revealing the optional steps (reality check · market check · design). |
| **C**  | **The hub**                               | the **canvas roadmap on the LEFT** — each done station **shows its captured findings** — + the **chat right rail**; here the agent raises the **validate-first ask** (with context) and **blocks** until you choose.                                                   |
| **D**  | **"Understanding your idea"**             | a **readable, READ-ONLY document** (editorial prose): what / who, the **mirror scan** (real comparables), inferred class + platform. React in the chat — no inline edit.                                                                                               |
| **E**  | **"What we'll build"**                    | a **READ-ONLY document**: in / out of scope (v1) + key decisions (pinned vs delegated). The **read → react → revise** loop runs through the **chat**, never inline.                                                                                                    |
| **F**  | **"Is it worth building?"** (opt.)        | a **READ-ONLY document**: the market, how hard it is to build, things to watch. Skipped (if at all) earlier, in the chat.                                                                                                                                              |
| **G**  | **"Will people want it?"** (opt.)         | a **READ-ONLY document**: demand + competition + the **validate-demand-first recommendation**, with the accept/decline **decision on the page** (also asked in the chat) — it **blocks** continuing.                                                                   |
| **G2** | **The gate rhythm + narration**           | the per-tier loop drawn: draft → READ-ONLY review → **Continue** → the conductor **narrates** the handoff (typing) and drafts the next tier; **Skip offered in the chat** for an optional tier; "Continue = navigation, nothing locked".                               |
| **G3** | **Going back — downstream-only cascade**  | a chat reaction at a LATER gate that the conductor attributes **upstream** sends you **back** to re-review that tier; the canvas shows the "Revisiting" state + downstream tiers "Will refresh"; cascade arrows point **downstream only**; nothing is locked.          |
| **H**  | **Design step** (whole page styled)       | the **ENTIRE page** — header, pickers, buttons, list, footer — rendered live in the chosen **style × palette × type**. Change a pick → it all restyles.                                                                                                                |
| **I**  | **The canvas as the roadmap** (post-plan) | the road continues past Plan: **Epic 1 (done) → Epic 2 (you are here, progress meter) → Epic 3 → + more**.                                                                                                                                                             |
| **J**  | **An epic expanded**                      | the epic opens to its **stories → subtasks** (the work-item tree, same road language) with per-item status + work-type chips (Code / Design / Content / …).                                                                                                            |
| **K**  | **Plan states**                           | the degraded **"AI planning not configured"** gate + loading / resume / error.                                                                                                                                                                                         |

---

## ⚠️ The canvas = one view of the work-item tree + the pre-plan phase

The canvas is **not a separate onboarding widget** — it is a **roadmap view** of
the same work-item tree the boards / backlog / list render, with the **pre-plan
phase** (Idea + the 4 docs) as its start. So the SAME surface serves the whole
journey:

- **Pre-plan (screen C):** the stations are Idea → Discovery → Vision → Feasibility
  → Validation → Design → (Plan), with the active one ringed and the optional ones
  tagged "can skip"; future epics are a dashed "after planning" station.
- **Post-plan (screen I):** the planning origin collapses to "Planning · done" and
  the road extends into **Epic stations** with progress meters + "you are here".
- **Expanded (screen J):** an epic's **stories → subtasks** render in the same
  node language — a roadmap = a planning origin + a tree, self-similar at every
  level. This is a NEW PRESENTATION of the shipped work-item tree, not a new data
  model. (Its own BUILD is a separate Epic-7 story — "planning canvas → persistent
  roadmap"; drawn here because the continuity is the point.)

---

## ⚠️ The design step styles its WHOLE self (screen H)

The design step is **web-only** (mobile skips it; skip → the default style, no
`DESIGN.md`). It is the third axis of Motir's own design system — **Colour
`data-palette` · Type `data-type` · Shape/feel `data-style`**. It is **not a
styled frame embedded in normal chrome** — the `data-style` / `data-palette` /
`data-type` attributes sit on the **whole panel surface**, so **every element on
the page** — the header, the **pickers**, every button, the input, the list, the
cards, the footer — renders in the selected design. **Change a pick and the whole
page restyles** (including the header). The page you are looking at _is_ the
example. (The doc & plan screens keep Motir's normal chrome — only the design step
restyles itself.)

Everything is faithful: the `[data-style]` / `[data-palette]` / `[data-type]` axis
blocks are **copied 1:1 from `app/globals.css`** and the six real next/font faces
(Inter · Source Serif 4 · JetBrains Mono · Space Grotesk · Fraunces · IBM Plex
Mono) are loaded, so the page re-shapes / re-skins / re-types exactly as the
running app does. The result composes into a `DESIGN.md` starter. The **v1 set**:

| Axis        | v1 entries                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| **Style**   | Warm Editorial (default) · Soft/Playful · Swiss/Minimal-Flat · Neo-Brutalism · Glassmorphism · Cybercore/Y2K |
| **Palette** | Motir (default) · Cobalt · Graphite · Evergreen · Spectrum                                                   |
| **Type**    | Motir (default) · Motir Sans · Motir Mono · Grotesk · Editorial · Mono-Technical                             |

> The shared style specimen of **7.3.37 / `MOTIR-1050`** (this design is
> `blocked_by` it) is, here, the whole styled page itself.
>
> **Mock-only adaptation:** in the app `data-palette` sits on `<html>`; because the
> styled panel is a nested element, the mock re-emits the derived `--el-*` layer
> scoped to `[data-palette]` so it recomputes locally. Style + type need no fix.

---

## ⚠️ The gate rhythm — the conductor DRAFTS, you Continue, it NARRATES (screen G2)

**One conductor drives the conversation, but each tier STOPS at a review gate.** The
conductor (`7.3.67`) does **not** ask _"shall I draft the next step?"_ and wait — it
gathers what it needs through the chat, then **drafts a tier on its own** and stops
at that tier's **review gate**. The user reads the READ-ONLY write-up and presses
**Continue**; the conductor then **narrates the handoff** in the chat (_"That's
Understanding your idea set — I've got enough to draft what we'll build. Writing it
up now…"_) with a typing indicator, and drafts the next tier. So the rhythm per tier
is: **draft → READ-ONLY review → Continue → narrate → next**.

**Continue is navigation, not sign-off.** Pressing Continue moves you forward; it
does **not** lock anything. **Nothing is locked until epic generation** — the single
commit at the end. The doc footers and the gate banner say so explicitly.

**Skip is a CHAT decision, before a tier drafts (not a button on a generated doc).**
For the two **optional** tiers (the worth-building check and the market check) — and
the design step — the conductor **offers Skip in the chat** before it drafts that
tier (`7.3.9` surfaces the per-tier skip control; when the interview already revealed
the work is done, it pre-suggests the skip). Pressing Skip **cancels that tier and
advances** to the next. A **generated report has nothing to "skip"** — once a doc is
on screen, its gate has only **Continue**. (This is why screen G2 draws Skip as chat
chips at the optional-tier handoff, never as a footer button on D/E/F/G.) Skips are
**dependency-closed**: skipping the worth-building check also drops the market check,
since validation builds on it (`7.3.23`).

## ⚠️ Going back — the downstream-only cascade (screen G3)

**The chat is the SOLE way to change anything — there is NO inline editing.** When
the user reacts in the chat, the conductor **classifies the impact across the whole
dependency DAG** (discovery → vision → feasibility → validation) — a remark made at a
**later** gate can change an **upstream** tier (the product can do the same thing a
different way). When it does, the machine sends the user **BACK to re-review that
upstream tier** ("Revisiting"), then **replays the gates forward**, while the
**downstream** tiers **re-derive** (`7.3.24`) — drawn on the canvas as "Will refresh".

**Cascade is DOWNSTREAM-ONLY.** A note at the market check can change your idea, but a
note about your idea never edits a step before it; upstream is never rewritten by a
downstream note. Because nothing is locked until generation, going back is always
safe — the G3 banner + the chat reassure the user of this.

## ⚠️ Validate-demand-first — the one BLOCKING ask (MOTIR-1064 / 7.3.47)

Most steps just flow, but **validate-demand-first is a genuine strategic decision**
(it can't be inferred — it's the user's call), so it is the **one place the agent
asks and waits**. The sequence (per `MOTIR-1064`): the agent **generates the
validation step summary** (screen G — the demand + competition write-up) → then
**asks in the chat, with context** from it → and **this BLOCKS the next step**
(Design / Plan stay locked until you choose). The default if the ask is never
reached is standard timing.

The decision appears in **both** places — **in the chat** (screen C) **and on the
validation page** (screen G, a decision block gating "continue"). **What "prove
demand first" means must be CONCRETE on the page** (Yue): it is not vague
"validation" — it means Motir **builds and launches a small marketing site first**
(a landing page that pitches the idea + a "notify me" waitlist) and **plans the
go-to-market**, **ahead of** the product build, so real sign-ups measure interest
before you commit. **On acceptance**, the plan **front-loads that launch slice** —
a `manual` domain-registration task, the marketing landing page + waitlist, and the
deploy tasks — sequenced **first**; the signups become the green light. **"No —
build it all"** keeps the standard order.

## ⚠️ Vertical canvas; step SUMMARIES, not "docs"

The canvas is a **vertical pipeline** (screen C) — the workflow runs **top to
bottom** (idea → the four checks → design → plan), and **each block shows what was
captured** (what/who/competitors · scope · market + risk), so the canvas is
informative, not empty boxes. The active step is ringed; done steps carry their
findings; upcoming steps are ghosted rows.

The four full-screen pages (D/E/F/G) are **step summaries** the user reads — a
clean **editorial write-up** (kicker + serif title + lead, then prose sections,
lists, a competitor "scan"), **READ-ONLY** (you react in the chat, never inline).
**Don't call them "docs" or number them "doc N of 4"** (Yue) — "doc" is an internal
word and there's nothing to download; each page is just the write-up of that step.

---

## Token / a11y discipline

- **Colour** strictly via `--el-*`; the showcase + specimens carry the palette in
  the `--el-*` layer (re-emitted for nesting); chips put the hue in the tint
  background with `--el-text-strong` (finding #35, AA). The only `--color-*` is
  inside the axis blocks copied 1:1 from `globals.css`.
- **Shape** strictly via element-semantic tokens (`--radius-*` / `--shadow-*` /
  `--spacing-*` / `--height-*`) — so the `[data-style]` swap re-shapes the
  showcase (that IS the demo). `rounded-full` only on dots / avatars.
- **Not colour-alone** — every station / state pairs an icon + label + tint; the
  roadmap "you are here" pairs a `map-pin` + label; pinned vs delegated keep their
  `pin` / `wand` markers; the new gate states pair a glyph + word —
  `Drafting now…` (`sparkles`) · `Will refresh` (`rotate`) · `Revisiting`
  (`corner-up-left`, ringed) — so the state never rests on hue alone.
- **AA holds** — each style × palette pair is AA by construction; Cybercore renders
  its native dark register.
- **A11y** — the chat rail and the canvas are labelled regions; decorative icons
  are `aria-hidden`; buttons carry accessible labels.

## Primitives composed (no hand-rolling)

| Element                           | Built from                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| canvas roadmap (stations + road)  | NEW ARRANGEMENT of `Card` (`.estation`) + tint glyph tiles + connector lines + progress meters                                                                                                    |
| chat rail + bubbles + composer    | `Card` + `Avatar` + `Input` (the compact right rail)                                                                                                                                              |
| full-screen step frame            | a `step-top` bar (`Button` back + a descriptive label) over a centred doc body                                                                                                                    |
| READ-ONLY doc body + read hint    | `Card` + prose sections + a `.doc-readhint` "react in the chat" banner (a `message` glyph, **never a `pencil`**)                                                                                  |
| doc-footer Continue gate          | `Button` (Back) + a `.gate-note` ("Continue = navigation, nothing locks until generate", `lock-open` glyph) + `Button` (Continue)                                                                 |
| gate banner / "going back" state  | `.gate-banner` (`Card` tint + glyph tile + title/desc); the `.back` variant tints peach for the cascade re-review                                                                                 |
| narration + cascade canvas states | the `.active-node` blocks reuse `Pill` states — `Drafting now…` / `Will refresh` / `Revisiting` (hue in tint bg, `--el-text-strong`) + a `typing` indicator + downstream `cflow` connector labels |
| full-page design showcase         | NEW ARRANGEMENT of `Card`/`Button`/`Pill`/list wrapped in the real axis attributes (the `/tokens` specimen pattern)                                                                               |
| epic → story → subtask tree (I/J) | NEW ARRANGEMENT of `Card` + the `--el-type-*` work-type hues + the connector language                                                                                                             |
| state callouts                    | `Card` tints + `Button`; the spinner is `Spinner`                                                                                                                                                 |
| icons                             | lucide-react + Google / GitHub marks                                                                                                                                                              |

## Deliverable

The three-file design-asset set under `design/ai-chat/`: `design-notes.md` (this
file) · `onboarding.mock.html` (the HTML mockup — source of truth, screens B–K incl.
the new G2 gate-rhythm + G3 cascade panels) · `onboarding.png` (the full-page
export). Rendered with Playwright chromium (full-page, light theme,
`deviceScaleFactor: 2`, 1200px wide); `prettier --check` clean.

---

## ⭐ The canvas is a SPATIAL canvas — Miro-style (2026-06-21 redesign, MOTIR-1235)

**Supersedes screen C's "vertical pipeline (down)".** The hub's left pane is not a
list — it is a genuine **2D spatial canvas** (Miro / tldraw feel). Asset:
`canvas-spatial.mock.html` (interactive: drag to pan, wheel to zoom) +
`canvas-spatial.png` (zoomed-in detail) + `canvas-spatial-overview.png` (zoomed-out,
the whole-project map). Approved direction (Yue, 2026-06-21):

- **Render the REALITY — the canvas never invents structure.** It is a live VIEW of
  the actual work-item tree + its actual dependencies: every node is a real station /
  epic / story, every edge is a **real dependency edge from the plan**, and the picture
  reflects what IS, not a designed diagram. The illustrative content in the mock
  (PayFlow, the named epics/stories) stands in for whatever the real project is — the
  BUILD reads the nodes + edges from the work-item graph (the pre-plan tier chain + the
  epic/story DAG) and renders them; it never hardcodes a layout or a link.
- **Pan** anywhere (drag the surface), **zoom in / out** (wheel / trackpad +
  `−` / `+` / `fit` controls, bounded ~30–200%). A subtle dot-grid backdrop reads
  as an infinite canvas.
- **Nodes are draggable.** Each station is a node the user can **drag to rearrange**;
  the arrangement **PERSISTS per user, per project** (a drag survives reload — the
  user shows the roadmap the way they want). Nodes **auto-initialise in a
  space-filling 2D FLOW** — a serpentine that uses the canvas WIDTH (the chain runs
  across the top, drops, and reverses; plan fans to the epics), NOT a single
  top-to-down column — so the space is utilised; the user takes it from there.
- **Links are PRE-DEFINED and READ-ONLY.** Edges are the work-item / pre-plan
  dependencies, drawn as curved connectors — there is **no link create / edit / delete
  on the canvas** (the canvas arranges and reads; it never restructures the plan). The
  pre-plan edges are the real tier dependency **chain** — each tier builds on the one
  before it: **idea → discovery → vision → feasibility → validation → design → plan**,
  so &ldquo;What we&rsquo;ll build&rdquo; (vision) links from &ldquo;Understanding your
  idea&rdquo; (discovery), matching the conductor&rsquo;s downstream-only re-derivation
  order (`DIRECTION_DOC_ORDER`) — NOT a free 2D branch. **The post-plan epics are a
  DAG of their REAL dependencies**, not a flat fan off `plan`: earlier epics usually
  block later ones — **Foundation blocks the implementation epics** (`Foundation →
Invoices`, `Foundation → Reminders`) — but it is **not a hard rule**, so independent
  epics run in **parallel** (e.g. the app `Foundation` and a `Marketing-site` epic both
  come straight off `plan`). Each epic fans to its stories. These edges are whatever
  the plan&rsquo;s real dependency graph says — the canvas renders them, it doesn&rsquo;t
  decide them.
- **One surface, whole journey.** The pre-plan stations (idea → the 4 tiers →
  design / plan slots) live on the same canvas that later carries the **post-plan
  epic → story clusters** (zoom out → the whole-project map). The post-plan RENDER is
  a separate Epic-7 story; the canvas is designed to accommodate it.
- **Node states** carry over from screen C — done (Reviewed ✓) · active/frontier
  (`map-pin` + ring + `aria-current`) · deciding (validation + the blocking ask) ·
  upcoming (ghosted, dashed) — each pairs an icon + label + tint (finding #35), with
  captured-findings rows on the produced tiers.
- **Tokens + a11y:** colour via `--el-*`, shape via element-semantic tokens; the
  canvas + chat are labelled regions; nodes are keyboard-focusable; zoom/pan have
  keyboard equivalents.

> **⚠️ AMENDED 2026-09-03 (MOTIR-4346) — the "colour via `--el-*`" clause above was
> FALSE of the asset from the day it was written, and is now true.** What
> `canvas-spatial.mock.html` actually declared was a `:root` of PRIVATE aliases
> carrying the design system's real values (`--muted: #787671`,
> `--surface: #ffffff`, `--hub: #f6f5f4`, …), and it painted a further **43 raw
> literals at their points of use**. Not one `--el-*` custom property appeared in
> the file. The values were right, and that was the trap: a raw hex does not flip with
> `data-palette`, does not follow a re-skin, and is invisible to every ink guard in
> the tree — `design-ink-contrast` and `design-state-ink-contrast` both classify an
> ink by reading an `--el-*` name off the DECLARATION at the point of use, so
> `color: var(--muted)` was unmeasured however `--muted` was defined. Both guards
> were green about this asset and neither had ever ruled on it.
>
> **What the swap changed on the record, token by token:**
>
> | was                                                                                                                                  | is                                                                                 | why                                                                                                                                                                            |
> | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | `--surface: #ffffff`                                                                                                                 | `--el-card`                                                                        | the map is by VALUE and ROLE: `--el-surface` is `#f6f5f4`, so a name-based substitution would have repainted every white node                                                  |
> | `--hub: #f6f5f4`                                                                                                                     | `--el-surface`                                                                     | the canvas + page ground — the other half of the same correction                                                                                                               |
> | `--muted` / `--faint` / `--strong` / `--text`                                                                                        | `--el-text-muted` / `--el-text-faint` / `--el-text-strong` / `--el-text`           | unchanged values, now measurable                                                                                                                                               |
> | `#0f5e29` on mint · `#3a2d8a` on lavender · `#8a3d00` on peach (the `Reviewed` / `You are here` / `Deciding` pills and their glyphs) | `--el-text-strong`                                                                 | `CLAUDE.md`'s coloured-chip rule — the hue lives in the tint BACKGROUND and the ink is `--el-text-strong` (finding #35). Three hand-darkened hues that reached no token at all |
> | `#54514b` (the captured-findings rows, the rail head)                                                                                | `--el-text-secondary`                                                              | the nearest token by value AND the one that clears AA on every surface                                                                                                         |
> | `#cfcac2` (the not-yet-reached dashed edges)                                                                                         | `--el-border-strong` (`#c8c4be`)                                                   | a 3-unit shift, imperceptible at a 2.5px dashed stroke; it is a quiet hairline and that is the token for one                                                                   |
> | `#ece9fb` (the first node's icon tile)                                                                                               | `--el-accent-wash` = `color-mix(in srgb, var(--el-accent) 11%, var(--el-page-bg))` | no `--el-*` exposes a wash this light; a `color-mix` over two tokens re-tints with the palette instead of freezing the hex                                                     |
> | `#e3e0db` (the dot-grid backdrop)                                                                                                    | `--el-border`                                                                      | the grid texture is the one raw value `CLAUDE.md` permits, and it costs nothing to route it through the token anyway                                                           |
> | `#5645d426` / `#5645d41f` (the active node's ring + lift)                                                                            | `color-mix(… var(--el-accent) 15%/12%, transparent)`                               | an alpha hex IS a mix ratio                                                                                                                                                    |
>
> The drawn layout, copy, elements and access paths are UNCHANGED — only the layer
> the colours are declared through moved. `canvas-spatial.png` and
> `canvas-spatial-overview.png` are both re-exported at `1280×760 @2x`
> (`2560×1520`, dimensions unchanged); the overview is the `?z=overview` view this
> section's header describes, and it is re-exported for the same reason the detail
> is — it draws the same inks.

**Build split (the canvas is a FOUNDATION):** a reusable `PlanningCanvas` component
(pan/zoom/drag/fit + node + read-only edge rendering — MOTIR-1236), per-user layout
persistence (MOTIR-1237), composed by the onboarding shell (MOTIR-840) and reused by
generation review (7.4) and the persistent roadmap (7.19).

---

## ⭐ The reusable AI planning workspace — shell + universal entrance (MOTIR-1193 / 7.20.1)

**THE ONE SHARED PLANNING INTERFACE.** Every AI-planning surface uses the SAME
structure — a full-screen **canvas (left) + chat (right)** workspace. Onboarding
(above) is one specialization; **generation review (7.4), re-planning (7.11),
contextual planning (7.12) and the persistent roadmap (7.19) REUSE this same
surface** as MODES (states), not separate UIs. This is the SINGLE design for it —
it supersedes the separate per-story designs `7.11.1`/`MOTIR-898` +
`7.12.1`/`MOTIR-907`.

**Asset:** `planning-workspace.mock.html` (source) + `planning-workspace.png`
(full-page export). A five-sheet review board:

> **⚠️ AMENDED 2026-09-04 (MOTIR-4428, under MOTIR-4318) — the asset is on the
> `--el-*` TOKEN LAYER, and until this sweep it was not.**
>
> Its own opening comment described the arrangement accurately and read as a
> decision rather than as debt: _"this sheet is an older light-only sketch that
> inlines the default Motir palette by hand as its own `--text`/`--accent`/
> `--border` names"_, with **THE ORB** carved out as the one thing drawn from the
> token chain (MOTIR-3217). So the file declared exactly **three** `--el-*`
> properties — `--el-accent`, `--el-accent-text`, `--el-highlight`, for the orb
> alone — against **THIRTY** private colour aliases, work-type limb included.
>
> **Why MOTIR-4318's sweep did not reach it, and why that was correct.** Its
> population predicate is _declares NO `--el-_` at all*; three declarations
> satisfy it, so this asset fell outside the eleven — and MOTIR-4318's own card
> names this file in exactly that role, AND predicts this shape as the reason its
> limb (b) had to exist (*"an asset that declares one token and aliases the rest
> — a file that passes the guard and is exactly as unmeasurable as the eleven"*).
> Both sentences are in the same card. What was never done is MEASURE limb (b)'s
> population, so the file named as *outside the eleven* and the shape named as
> *what limb (b) is for\* were never put beside each other. That measurement gap
> is a separate planning bug; this is the sweep.
>
> **What it cost, measured rather than described.** Both ink scanners classify an
> ink by reading an `--el-*` name off the declaration AT THE POINT OF USE, so
> `color: var(--muted)` is unmeasured however `--muted` is defined. Run against
> this asset:
>
> |                                        | `design-ink-contrast` (RESTING)                             | `design-state-ink-contrast` (STATE)  |
> | -------------------------------------- | ----------------------------------------------------------- | ------------------------------------ |
> | **before the sweep**                   | **0 sites scanned**, 0 violations                           | 0 state background rules, 0 findings |
> | after the token swap, before re-inking | 55 sites scanned, **55 muted violations**, 24 faint counted | 0 rules, 0 findings                  |
> | **after**                              | 0 sites scanned, 0 violations                               | 0 rules, 0 findings                  |
>
> The middle row is the point: the asset was green about thirty-two ink sites it
> had never been asked about, and its `--muted` / `--faint` inks are precisely the
> two `CLAUDE.md`'s measured table (MOTIR-2455) exists to police. It carries no
> `:hover` / `:focus` state background rule, so the STATE arm has nothing to rule
> on either way — that zero is a real reading, not an abstention.
>
> **What the swap changed on the record, token by token:**
>
> | was                                                                                                 | is                                                                                                         | why                                                                                                                                                                                                                                                                                                                                                                                                |
> | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `--surface: #ffffff`                                                                                | `--el-card`                                                                                                | mapped by VALUE and ROLE: `--el-surface` is `#f6f5f4`, so a name-based substitution would have repainted every white panel                                                                                                                                                                                                                                                                         |
> | `--hub: #f6f5f4`                                                                                    | `--el-surface`                                                                                             | the board ground — the other half of the same correction                                                                                                                                                                                                                                                                                                                                           |
> | `--text` / `--strong` / `--soft` / `--mutedfill` / `--border` / `--hair`                            | `--el-text` / `--el-text-strong` / `--el-surface-soft` / `--el-muted` / `--el-border` / `--el-border-soft` | unchanged values, now measurable                                                                                                                                                                                                                                                                                                                                                                   |
> | `--secondary: #54514b` · `--rose: #fce4ea` · `--yellow: #fbf2cc`                                    | `--el-text-secondary` `#5d5b54` · `--el-tint-rose` `#fde0ec` · `--el-tint-yellow` `#fef7d6`                | three hand-inlined values a few units off the system's own; the asset now states the ROLE and the system states the value                                                                                                                                                                                                                                                                          |
> | `--accent-soft: #ece9fb`                                                                            | `--el-accent-wash`, a `color-mix(in srgb, var(--el-accent) 11%, var(--el-page-bg))`                        | a frozen tint of ONE palette's accent. No `--el-*` exposes a wash this light, so it is a mix whose inputs are BOTH tokens, declared in the `[data-palette]`-aware block so it re-tints with the accent it is drawn from                                                                                                                                                                            |
> | `--pink: #ff64c8`                                                                                   | `--el-highlight`                                                                                           | the same value the orb block already read from `--color-accent`                                                                                                                                                                                                                                                                                                                                    |
> | `--type-epic` / `-story` / `-task` / `-bug` / `-subtask`                                            | `--el-type-epic` / `-story` / `-task` / `-bug` / `-subtask`                                                | **NOT** the allowlist case MOTIR-4318 predicted for a work-type palette: `theme.css` declares all five and MOTIR-4350's swept `design/roadmap/roadmap.mock.html:67`–`71` declares exactly these names. The old block's own comment already named them                                                                                                                                              |
> | the `TYPE` map in the sheet's `<script>`, five raw hexes painted onto an inline `style=` at runtime | `var(--el-type-*)`, with the `+ '22'` alpha trick replaced by `color-mix(in srgb, <hue> 13%, transparent)` | the one set of colours in this sheet that NO static scanner reads either way, which is why they were the last five raw hues left. `0x22 / 255` is 13%, and a `var()` cannot carry an 8-digit-hex alpha                                                                                                                                                                                             |
> | 20 `color: var(--muted)` + 12 `color: var(--faint)` ink sites                                       | `--el-text-secondary`                                                                                      | what the swap EXPOSED. `--el-text-muted` is 4.12–4.34:1 on every tinted surface and `--el-text-faint` clears AA on none; secondary is 6.18–6.80:1 on all four surfaces in both themes, which is `CLAUDE.md`'s own advice for exactly this case. Both tokens stay DECLARED — `mockStateInkScan` resolves a token by planting a probe, and an asset declaring neither reports its faint ink as muted |
>
> **What is unchanged:** the ORB's colour chain (MOTIR-3217) and the ten
> `[data-palette]` Tier-0 blocks under it — that half was already the Tier-0 →
> Tier-3 → paint form this sweep gives the rest of the sheet, and it is where the
> pattern for the rest came from. The `.png` re-exported at byte-identical
> dimensions (`EXACT 1200x900@2x`, 2400×10856).

| Sheet | What it shows                                                                                                                                                                                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | The shell — full-screen two-pane workspace (canvas left · chat right), no app nav                                                                                                                                                                                                             |
| **2** | Chat-to-plan — proposed cards land on the canvas one-by-one, with edges, pending until Confirm (confirm-to-persist)                                                                                                                                                                           |
| **3** | The four MODES (generation / re-plan / contextual / roadmap-read) as STATES of the one surface, each tied to its entrance door                                                                                                                                                                |
| **4** | The universal entrance — BOTH hero affordances: the header "Plan with AI" pill + the floating Motir callout; context → mode adapts                                                                                                                                                            |
| **5** | Style-aware — the "Plan with AI" control rendered special in each `data-style` (Editorial / Soft / Swiss / Brutalism / Glass / Cybercore)                                                                                                                                                     |
| **6** | Opening & exiting — the workspace as the shipped `Modal size="full"`, EDGE TO EDGE over the page you are on: the four exits, the NAMESPACED query contract, the cold deep link + signed-out hop, the close-with-pending guard, every state, and the doors before/after (AMENDED — MOTIR-4726) |

### ⚠️ SCOPE — this designs the SHELL + ENTRANCE, NOT the canvas pane

The canvas pane is the **standalone work-item canvas** — already designed +
owned elsewhere; this asset **COMPOSES it, it does NOT redesign it**:

- **The canvas DESIGN** = **MOTIR-1009** (`7.3.76`, done) → the three-file asset
  at **`design/roadmap/`** (the deterministic auto-layout, the work-item tree,
  the dependency edges — within-story arrow vs the cross-story warning edge —
  zoom / fit, search-to-focus, filters, node states, drill-down, empty/loading/
  error). This asset READS it and reuses its node + edge language; it does **not**
  re-draw the tree / edges / zoom / search.
- **The canvas COMPONENT** = **MOTIR-1194** (`7.3.77`, the reusable
  `WorkItemCanvas`) → the code this workspace's canvas pane MOUNTS. A FOUNDATION
  (it does not depend on this design); this workspace is one of its consumers.

So the mock's canvas panes are the `design/roadmap/` canvas language reproduced
faithfully (the `StationCard` node + the `PlanningCanvas` neutral firm /
dashed-pending edges + the cross-story `--el-warning` edge), **never a new
canvas**.

### The orb's colour is READ from the token layer, not painted (MOTIR-3217)

Sheet 4's floating orb is drawn twice (`.fab` on the faux page, `.orb` in the
anatomy close-up and the palette strip). Until 2026-08-20 both carried the same
literal —
`radial-gradient(circle at 33% 27%, #9c81ff, #5645d4 58%, #4733bd)` plus a
`#ffffff6e` rim, a `#5645d4cc` drop and a `#ff64c895` glow — three invented hues
that reached **no token at all**. Two consequences, and the second is the one
that lasts:

- **It could not follow a `data-palette` swap.** `data-palette` re-points
  `--color-primary-fill` / `--color-primary-foreground` / `--color-accent` across
  ten palettes; a hex follows none of them, so this sheet depicted the `motir`
  palette while its own closing note claimed "`--el-*` palette-derived colour".
- **Its first stop measured 2.995:1 against the white mark** — the same WCAG
  1.4.11 miss MOTIR-3207 was filed for, in the asset next door, one week after
  that asset recorded the finding.

Both rules now reproduce the shipped `PlanWithAIFab` `ORB_STYLE` **stop for
stop**, in the tokens the app uses:

```css
background-image: radial-gradient(
  circle at 33% 27%,
  color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)),
  var(--el-accent) 56%,
  color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight))
);
```

with the rim, drop and glow as `--el-accent-text` / `--el-accent` /
`--el-highlight` mixes, the mark's stroke as `--el-accent-text`, and the first
stop's mix READ from `--orb-lit-mix` — the contrast knob § _B_ documents, never
retyped here. The geometry moved with it: the old sketch's `58%` body stop is
now the shipped `56%`, and the third stop is the shipped
`--el-highlight`-leaning mix rather than a flat `#4733bd`. **Recorded ratios,
default palette: 3.77:1 light · 3.09:1 dark**, with every one of the twenty
palette × theme contexts clearing 3:1.

Only the tokens the orb reads are inlined (Tier-0 `--color-*` → Tier-3
`--el-*` → the paint, extracted verbatim from
`packages/design-system/theme.css`, plus each palette's Tier-0 triplet). **The
rest of this sheet is still an older light-only sketch that inlines the default
palette by hand** as `--accent` / `--border` / `--muted`; that is left alone
deliberately — this card re-expresses colours that already exist, it is not a
re-skin of the board. Sheet 4's palette strip is the visible proof: the same
rule under all ten `data-palette` values, including the four whose
`--color-primary-foreground` is not white.

`tests/theme/orb-glyph-contrast.test.ts` holds both halves — the gradient must
equal the shipped one and contain `var(--orb-lit-mix)`, and no rule the orb is
made of may carry a raw hex. It runs on `design/*` branches via
`vitest.design.config.ts` (MOTIR-2442), which is the only lane that sees them.

### ⭐ Built on SHIPPED REALITY (design-against-shipped-reality)

The shell is **already shipped** and reused, not reinvented:

- **The shell** = `components/planning/PlanningWorkspace.tsx` — the full-screen
  two-pane frame: `grid h-dvh w-full grid-cols-1 md:grid-cols-[1fr_22rem]`
  (canvas left, a **22rem** chat rail right), **no app shell / sidebar / top
  nav** — a focused planning surface. The mock mirrors this exactly.
- **The chat rail** = `components/onboarding/DiscoveryChatRail.tsx` — the mock
  reproduces its real markup: the rail header (a `--el-success` status dot + the
  mono uppercase **"Motir AI"** label), the `Bubble` + `Avatar` language
  (AI = `--el-accent` avatar + soft bubble; user = accent bubble), the drafting
  `Spinner` indicator, and the composer (`Input` + a primary `Send` button).
  The one new rail element is a small **mode chip** (mono, accent tint) naming
  the active mode — the only per-mode difference in the rail.
- **The global launcher** composes `components/ui/CommandPalette.tsx` (the wired
  ⌘K palette, app composition in `(authed)/_components/AppCommandPalette.tsx`):
  a **"Plan with AI"** command in a `Plan` group.

### Chat-to-plan, on-canvas incremental placement & confirm-to-persist (sheet 2)

> **⚠️ No "plan" button INSIDE the workspace (Yue, 2026-06-24).** Inside, the
> user **just chats** — there is **no "Plan with AI" action/button** on the canvas
> or anywhere in the shell. The **conversation itself turns into a plan**: as you
> talk, proposed cards appear on the canvas. "Plan with AI" names **only the
> ENTRANCE** (the affordance that opens this from the app); once you're in, the
> canvas is just the project roadmap and the **chat is the sole input**. (The
> canvas chrome shows the project / roadmap context + Close + search — never a
> "plan" button; the composer reads "Message Motir AI…", not "describe what to
> plan".)

- **The chat drives; the conductor proposes work.** Free-form chat in the rail
  → the conductor proposes work items. The user never presses "plan" — talking
  is planning.
- **On-canvas incremental placement.** Proposed work items appear on the
  standalone canvas **one by one**, each drawn with its **relationship edges** —
  parent→child, the within-story `depends_on` arrow, and the cross-story
  `blocked_by` warning edge — in the canvas's own node + edge language.
- **Confirm-to-persist.** The proposed set is a **STATE of the canvas** —
  pending nodes (a dashed `--el-accent` border + a `proposed` `Pill`) and
  pending edges (dashed). **Nothing is written to the DB until the user presses
  Confirm**; **Discard** drops the whole proposal. This IS the diff/review
  surface — there is no separate review screen. The gate is a floating bar:
  _"N proposed work items · Nothing saved yet"_ + **Discard** / **Confirm & add
  to project**.

### The MODES — states of the one surface, each opened by a door (sheet 3)

All four differ ONLY in (a) what the canvas is seeded with and (b) the chat
driver's framing — the shell, the placement, and the confirm gate are identical.
**Grounded in the workflow-defining stories** (design TO the spec, never invent
the flow):

- **Generation review — 7.4 (`MOTIR-805`).** Door: a project surface with **no
  plan yet** → generate the first fresh tree from the frozen baseline → review →
  Confirm persists. (7.4 is fresh, empty-skeleton generation.)
- **Augment / re-plan — 7.11 (`MOTIR-811`).** Door: a project surface **with a
  plan** → expand / re-sequence; **completion-aware** — done work stays locked,
  new cards propose around it.
- **Contextual planning — 7.12 (`MOTIR-812`).** Door: **from a specific work
  item** (detail page / row action) → planning **scoped to that item's subtree**
  (the canvas focuses that item; proposals are its children).
- **Roadmap read + augment — 7.19 (`MOTIR-1008`).** Door: the **Board ↔
  Roadmap** toggle → the persistent roadmap; read the whole tree, augment in
  place.

Onboarding (7.3) is the one specialization that wraps this shell in its gated
per-tier pre-plan review loop (see `onboarding.mock.html`).

### ⚠️ The universal entrance — global hero affordances, not per-surface (sheet 4)

**Corrected 2026-06-24 (Yue): NOT one door per screen.** The global **header**
(`TopNav`) and the **⌘K** command menu are present on **every** PM screen, so AI
is reachable everywhere via **global** affordances, not a per-surface button. And
because this is the
**product's headline feature / selling point**, the affordance is a **hero
control** — gradient fill, a soft glow / aura, a `Sparkles` mark, a subtle
shimmer — **never a plain toolbar button**. (This supersedes the earlier
per-surface in-situ grid, which multiplied a regular button across seven
surfaces — wrong on both counts.)

**We ship BOTH entrances** (refined 2026-06-24, Yue) — they are complementary,
both always-present, and both restyle with the active design style (sheet 5);
⌘K opens the workspace too:

- **A — the header "Plan with AI" pill.** A gradient hero pill in `TopNav`'s
  right cluster, present on every screen, never covering content — the direct
  **planning** entrance; opens the workspace in the current context's mode.
- **B — the floating Motir orb = the universal AI callout.** A glowing orb
  wearing the **Motir mark** afloat bottom-right on every screen; tapping it opens
  the AI callout — **the home of ALL AI**, where **Plan with AI is ONE action**
  alongside **"Ask about this project"** (Q&A over the plan / docs / work items)
  and **"Help with a task"** (draft / summarise / assist). Planning is the
  capability this design+story deliver now; project Q&A and task assistance are
  **future capabilities reached through the same button**. The callout menu
  composes `Card` + list rows + an "Ask Motir anything…" input.

  > **✅ Deferral discharged 2026-08-19 (MOTIR-3183).** This bullet used to read
  > _"Built now with a mock `M` logo — the real brand logo replaces it later (the
  > orb is the logo's home)."_ It does now. The orb renders the **wave band**,
  > read from `design/brand/wave-band-24.svg`, at a **26 px glyph box in the 56 px
  > circle** (the box the letter occupied, so the swap changes _what_ is in the
  > circle and not how much of it is filled). **Centred geometrically**: the ink
  > centroid sits at (11.705, 11.820) on the 24 grid against a bbox centre of
  > (11.975, 11.975), an offset of 0.27 / 0.16 units = **0.29 / 0.17 px at 26 px**,
  > below half a device pixel — so no optical nudge is applied, and the number is
  > recorded because _"it looks centred"_ is the claim it replaces. The same mark
  > rides the **28 px assistant avatar** in both rails at a 13 px box — the same
  > 0.464 glyph-to-circle ratio, so the two read as one object at two sizes. The
  > mark is `fill="currentColor"` and therefore **needs no dark variant**. Drawn in
  > `ai-callout-menu.mock.html` panel 9; the code swap is MOTIR-3185, which composes
  > `BrandMark` `variant="mark"` rather than inlining an `<svg>`.
  >
  > **⚠️ And a finding, recorded not inherited.** Measured against the orb's own
  > gradient, white-on-accent cleared 3:1 in light (**#8c81e2, 3.32:1** at the
  > gradient's lightest point) and **missed it in dark (#9b90e8, 2.78:1** — WCAG
  > 1.4.11 for a non-text graphic). This was **pre-existing** — the mock `M` was
  > white on the same gradient and measured the same — but this was the pass that
  > measured it. Not changed here: the orb's fill belongs to MOTIR-1811 (`done`).
  >
  > **✅ Fixed 2026-08-20 (MOTIR-3207), and the remedy is one number — though not
  > the one this note proposed.** The shipped values are now **#8275df, 3.77:1**
  > light and **#9286e6, 3.09:1** dark. The note above recommended a _theme-aware_
  > mix on the reasoning that light had headroom at 32%; re-measured across the
  > whole shipped matrix — ten `data-palette` values × both themes, resolved from
  > the tokens rather than from the default pair — that is a property of the
  > **default palette**, not of light. **Four** of the twenty contexts failed at
  > 32% (default dark 2.78:1, `cobalt` dark 2.86:1, `spectrum` dark 3.00:1 —
  > 2.999, under the bar — and `evergreen` **light** at **2.94:1**), so a
  > `[data-theme='dark']` override of the stop would have left a light orb below
  > the bar. The fix is therefore **one global 26%**, expressed once as
  > `--orb-lit-mix` in `packages/design-system/theme.css` and read from there by
  > both `PlanWithAIFab` and `ai-callout-menu.mock.html` panel 9. Worst context
  > after the change: **3.09:1**; all twenty clear 3:1. Because mixing the glyph's
  > own colour into its backdrop is monotonic, the knob is a **ceiling** — only
  > raising it can break the bar — and `tests/theme/orb-glyph-contrast.test.ts`
  > re-derives every context from the tokens on every run.

**⚠️ The hero control is STYLE-AWARE — special in every design style (sheet 5).**
It is not a fixed gradient: each `data-style` gives the "Plan with AI" control a
**distinct, special treatment** — Warm Editorial (gradient + glow + shimmer),
Soft/Playful (rounded, pillowy stacked shadow), Swiss/Minimal-Flat (flat solid,
sharp, uppercase), Neo-Brutalism (hard border + offset hard shadow), Glassmorphism
(frosted translucent over a colourful surface), Cybercore/Y2K (dark surface + neon
glow + mono). The floating **M** orb adopts each style's material the same way.
Implemented as a **per-style material surface** (the sanctioned exception, like
glassmorphism): `[data-style='id'] [data-surface='ai-cta'] { … }` rules whose
colour is **palette-DERIVED** (`color-mix()` / `var(--el-accent|--el-highlight)`,
no raw hex) and whose radius/padding/shadow flow through element-semantic **shape**
tokens — so a `data-palette` swap re-tints every style's treatment and a
`data-style` swap re-shapes it (the axes stay disjoint). **AA holds in each**
(label over the accent-dominant region; Cybercore renders its native dark
register).

**The anatomy of the hero control** (drawn in the sheet-4 close-up):

- **Gradient fill** — `--el-accent` → an `--el-highlight`-derived violet/pink;
  white label text sits over the **accent-dominant** region so **AA holds** (the
  brand pink lives only in the glow/aura, never under text).
- **Aura / outer glow** — a soft pink + violet halo so it lifts off the chrome.
- **Sparkle mark** (lucide `Sparkles`) + a **shimmer sweep** (a slow loop in the
  build) — the living, AI feel.
- An optional **conic-gradient ring** for a premium rim (shown on the close-up).
- This is a **sanctioned "feature surface" exception** to the flat-button norm
  (like the surface-material styles): the gradient + glow are **palette-DERIVED**
  (`color-mix()` / `var(--el-accent | --el-highlight)`, **no raw hex hue**), so a
  `data-palette` swap re-tints the hero and a `data-style` swap leaves its hue
  alone. Shape (radius/padding) still flows through semantic tokens.

**ONE door that ADAPTS — context → mode** (not seven doors). The single
affordance opens the workspace in the mode for the **current context**:

| Current context                                | Mode it opens                            | Story |
| ---------------------------------------------- | ---------------------------------------- | ----- |
| viewing a **work item**                        | contextual planning, scoped to that item | 7.12  |
| a **project surface** (board / backlog / list) | augment / re-plan                        | 7.11  |
| an **empty project** (no plan yet)             | generation                               | 7.4   |
| the **roadmap**                                | roadmap read + augment                   | 7.19  |

- **Implementation** = the reusable **`PlanWithAILauncher`** (**`MOTIR-1299`** /
  `7.20.3`, `blocked_by` this design): it renders **both** hero controls (the
  header pill + the floating **M** callout), opens the `PlanningWorkspace`, and
  passes the originating context so it lands in the matching state (sheet 3). The
  callout's non-planning actions (project Q&A, task assistance) are future
  capabilities that mount in the same menu.
- The **work-item detail door** (`MOTIR-910`) and the **Board ↔ Roadmap toggle**
  (`MOTIR-1011`) are **the same launcher in context**, not separate inventions.
  (The authed roadmap + toggle are owned by 7.19/`MOTIR-1011` and not shipped yet
  — only the public roadmap exists today; that door reuses this launcher when
  1011 lands.)

### ⭐ The STYLE MATRIX — all eleven registered styles, drawn (MOTIR-4742, 2026-09-06)

The paragraph above promises a per-style treatment and names six styles. **The
registry holds eleven.** This section draws the other five, re-draws the six in
the mechanism the stylesheet actually uses, and states the hook the app has to
emit — because none of that existed in a form an implementation could copy
(MOTIR-4743 is the bug it unblocks).

#### The set is DERIVED, not enumerated

**The eleven rows below ARE the eleven `[data-style]` token blocks in
`packages/design-system/theme.css`, and that is the definition — not a list
somebody kept in step.** Re-derive it with:

```sh
grep -c "^\[data-style=" packages/design-system/theme.css   # 12 matches
grep    "^\[data-style=" packages/design-system/theme.css   # 11 distinct styles
```

The count is **12 and the answer is 11**: `[data-style='neumorphism'][data-theme='dark']`
is a THEME variant of a style already in the set, not a twelfth style. Counting the
grep is how this section would acquire a phantom row, so the number is written down
beside the command that produces it. `lib/theme/styles.ts` is the registry the app
reads; a style present there and absent here is a **defect in this section**, on the
same closure rule `docs/styles/3d-immersive.md` §4b states for the plane ladder.

#### ⚠️ What already reaches these controls — measured, not assumed

Rendered headlessly from the real `theme.css` against the SHIPPED
`PlanWithAILauncher` and `PlanWithAIFab` (design-against-shipped-reality), the
current state is **not** "the style axis does not reach the hero". It is narrower
and more useful than that:

| axis                            | reaches the hero today? | evidence                                                                                                                                                                            |
| ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Radius**                      | ✅ **yes**              | `--radius-badge` resolves to `9999px` · `2px` (Swiss) · `0` (Brutalism) · `2px` (Cybercore) · the wonky `9px 26px 11px 22px / 22px 11px 24px 9px` (Hand-Drawn)                      |
| **Padding**                     | ✅ **yes**              | `--spacing-btn-x` resolves to `16px` · `18px` · `20px` · `22px` across the eleven                                                                                                   |
| **Height**                      | ✅ yes (uniform)        | `--height-btn-md` is `40px` in all eleven — the token flows; the styles simply agree                                                                                                |
| **Shadow**                      | ⚠️ **one style only**   | `--plan-hero-shadow` / `--plan-orb-shadow` are set by `3d-immersive` alone (`theme.css:1688-1701`, MOTIR-3522). Every other style falls through to the component's literal fallback |
| **Fill · border · glow · type** | ❌ **no**               | byte-identical in all eleven — the inline `background-image` beats every rule, and there is no hook to write one against                                                            |

So the rows below change **fill, border, shadow/glow, type and ink**. They do
**not** re-declare radius, padding or height: those already flow, and a rule that
re-stated them would freeze the one axis that is working.

#### ⚠️ The HOOK — and why ONE attribute is not enough

The prescription above is `[data-style='id'] [data-surface='ai-cta']`. **No element
in `app/` or `components/` emits `data-surface="ai-cta"`** — the string occurs
nowhere outside `design/`. Emitting it is MOTIR-4743's first job, and it emits
**two** attributes, not one:

```html
<!-- components/planning/PlanWithAILauncher.tsx — the header pill -->
<a data-surface="ai-cta" data-ai-cta="pill" data-depth="key" …>
  <!-- components/planning/PlanWithAIFab.tsx — the floating M orb -->
  <button data-surface="ai-cta" data-ai-cta="orb" data-depth="key" …></button
></a>
```

**The second attribute is load-bearing and is a finding, not a convenience.** The
two controls do not share a fill RECIPE: the pill is a 135° linear gradient, and the
orb is a _lit sphere_ — `radial-gradient(circle at 33% 27%, …)` whose first stop is
`--orb-lit-mix`, a **guarded contrast knob** (MOTIR-3207; `tests/theme/orb-glyph-contrast.test.ts`
re-derives all twenty palette × theme contexts against a 3:1 floor). A per-style rule
written against `[data-surface='ai-cta']` alone would set one `background-image` over
both and **silently overwrite the orb's measured recipe** — turning a guarded 3.78:1
into whatever the style's pill gradient happens to give. So every fill below is
written under `[data-ai-cta='pill']` or `[data-ai-cta='orb']`, and only the
shape-agnostic properties (border, outer glow, type, ink) are written on the shared
`[data-surface='ai-cta']`.

`data-depth="key"` already ships on both (MOTIR-3522 / §4a) and is **not** replaced by
this hook: it declares the 3D plane, `data-ai-cta` declares which hero control this is.

#### ⚠️ How the ORB takes each style (AC 5 — "the same way" is not self-evident)

The orb is a circle, the pill a pill, so "the orb adopts each style's material the
same way" needs a rule rather than a promise. It is this:

1. **The lit-sphere fill is NEVER replaced — it is COMPOSED OVER.** Each style adds
   its material as an extra `background-image` layer _above_ the shipped radial
   gradient (a sheen, a grid, a bevel), or changes nothing at all. The shipped
   radial stays the last layer, so `--orb-lit-mix` keeps deciding the glyph's
   contrast under every style.
   **⚠️ AND THE ADDED LAYER IS CONFINED TO THE CROWN** — `background-size: 100% 20–26%`,
   above the centred 26/56 glyph box. Composing a LIGHT layer over the sphere breaks the
   guarded floor just as surely as replacing the fill does: measured across the whole
   circle, glassmorphism's sheen and retrofuturism's crown put the glyph box at 3.17:1 /
   2.67:1 and 3.34:1 / 2.78:1, under the 3:1 bar
   `tests/theme/orb-glyph-contrast.test.ts` enforces. Confined, both measure the shipped
   3.78:1 / 3.10:1 — the sheen is a rim treatment, not a wash (finding C below).
2. **Radius is not a style axis for the orb.** It is `rounded-full` by definition;
   a style that squares the pill (Swiss, Brutalism, Cybercore) leaves the orb round.
   The orb carries that style's _border, shadow/glow and material_ instead — which
   is precisely what makes the two read as one family at two shapes.
3. **Anything the pill expresses as TYPE, the orb expresses as GLYPH WEIGHT** — the
   orb has no label. Uppercase/mono/letter-spacing rows below therefore say
   "n/a (glyph)" for the orb.

#### The eleven rows

Colour is `color-mix()` over `--el-accent` / `--el-highlight` / `--el-accent-text`
throughout; **no row names a raw hex**. Cybercore and Retrofuturism additionally mix
toward the achromatic `white` / `black` KEYWORDS — sanctioned by those styles' own
material layers, which use them to read as _lightness_ rather than as a hue, so the
palette axis stays disjoint (`theme.css`, the retrofuturism block's header). Shape is `--radius-badge` /
`--height-btn-md` / `--spacing-btn-x`, already flowing (table above). Ink is
`--el-accent-text` in every row — the styles change the GROUND, never the ink, which
is what keeps the AA argument one-dimensional.

**AA is measured, not asserted.** Every ratio below was computed by resolving the
tokens through a real CSS engine and reading the PAINTED pixel, then applying WCAG
2.x — never from the token names. Default `motir` palette; the label is
`--el-accent-text` (`#ffffff`) over the **accent-dominant** region of that style's own
fill. The method reproduces the shipped orb figures exactly (3.78:1 light / 3.10:1
dark against `design-notes.md` § B's recorded 3.77 / 3.09), which is what makes the
new numbers trustworthy.

| #   | Style                     | Fill (pill)                                                                                                              | Border                                                                                            | Shadow / glow                                                                                                    | Type                                    | Label AA — light / dark |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------- |
| 1   | **Warm Editorial** (base) | 135° `--el-accent` → `color-mix(--el-accent 86%, --el-highlight)` — **accent-dominant, see the base-fill finding below** | none                                                                                              | inner sheen + violet drop + pink aura (the component's own `var()` fallback)                                     | sans, 600, sentence case                | **5.97** / **4.64**     |
| 2   | **Soft / Playful**        | as base                                                                                                                  | none                                                                                              | **pillowy stack**: a hard `0 7px 0 -1px` ledge in `color-mix(--el-accent 22%, --el-page-bg)` + a wide soft bloom | sans, **800**, sentence case            | **5.97** / **4.64**     |
| 3   | **Swiss / Minimal-Flat**  | **flat solid `--el-accent`** — no gradient                                                                               | none                                                                                              | **none** (the style removes every shadow; depth is hairline + whitespace)                                        | sans, 700, **UPPERCASE**, `0.07em`      | **6.57** / **4.99**     |
| 4   | **Glassmorphism**         | **frosted**: `color-mix(--el-accent 86%, transparent)` + `backdrop-filter: blur(var(--glass-blur))`                      | `1px` `var(--glass-rim)`                                                                          | inner rim sheen + diffuse lift                                                                                   | sans, 600, sentence case                | **4.87** / **5.73**     |
| 5   | **Neo-Brutalism**         | **flat solid `--el-accent`**                                                                                             | **2px solid `--el-text`**                                                                         | **hard offset, zero blur** — `4px 4px 0 var(--el-text)`                                                          | sans, 800, **UPPERCASE**                | **6.57** / **4.99**     |
| 6   | **Cybercore / Y2K**       | dark HUD ground: `color-mix(--el-accent 88%, black)` → the highlight mix taken 78% to black                              | `1px` `color-mix(--el-highlight 70%, transparent)`                                                | **neon halo, no drop shadow**: `0 0 10px` / `0 0 26px -4px` over `--el-highlight` / `--el-accent`                | **mono** (`--font-mono`), 600, `0.04em` | **7.42** / **6.10**     |
| 7   | **Aurora**                | base + a lit-from-within crown sheen at `--aurora-sheen`                                                                 | none                                                                                              | **colour halo** at `--aurora-glow`, no hard shadow                                                               | sans, 600, sentence case                | **5.97** / **4.64**     |
| 8   | **3D / Immersive**        | as base — **unchanged**                                                                                                  | none                                                                                              | ⚠️ **NOT SET HERE** — the shipped `--plan-hero-shadow` / `--plan-orb-shadow` own it (see below)                  | sans, 600, sentence case                | **5.97** / **4.64**     |
| 9   | **Hand-Drawn / Indie**    | as base                                                                                                                  | **2px `--el-border-strong`**, warped by the shared `#hd-rough` filter on a content-safe `::after` | soft hand-placed offset, `3px 4px 0 -1px color-mix(--el-border-strong 55%, transparent)`                         | sans, 700, sentence case                | **5.97** / **4.64**     |
| 10  | **Neumorphism**           | **flat solid `--el-accent` — no gradient, no glow**                                                                      | hairline `1px color-mix(--el-accent 70%, var(--el-text))` (KEPT, never removed)                   | **paired extrusion**: `--neu-distance` / `--neu-blur` with `--neu-light` up-left and `--neu-shadow` down-right   | sans, 600, sentence case                | **6.57** / **4.99**     |
| 11  | **Retrofuturism**         | **chrome bevel** (vertical `+18% white` → `--el-accent` at 20% → `+16% black`) + a **crown-confined** specular streak    | `1px color-mix(--el-accent-text 30%, transparent)`                                                | colour glow at `--retro-glow` + the bevel's inner top highlight                                                  | sans, 600, sentence case                | **6.76** / **5.16**     |

**Every row clears WCAG AA for normal text (4.5:1) in both themes**, and every orb glyph clears the
3:1 non-text floor `--orb-lit-mix` was tuned to hold. The tightest label is **Glassmorphism at
4.87:1 (light)**; the tightest orb is **3.10:1 (dark)**, which is the shipped orb's own figure —
no style moves it, by construction.

|                                                          | pill light | pill dark | orb light | orb dark |
| -------------------------------------------------------- | ---------- | --------- | --------- | -------- |
| Warm Editorial · Soft/Playful · Aurora · 3D · Hand-Drawn | 5.97       | 4.64      | 3.79      | 3.10     |
| Swiss · Neo-Brutalism                                    | 6.57       | 4.99      | 3.79      | 3.10     |
| Glassmorphism                                            | 4.87       | 5.73      | 3.78      | 3.10     |
| Cybercore / Y2K                                          | 7.42       | 6.10      | 3.72      | 3.11     |
| Neumorphism                                              | 6.57       | 4.99      | 6.57      | 4.99     |
| Retrofuturism                                            | 6.76       | 5.16      | 3.78      | 3.10     |

#### ⚠️ FOUR places the measurement changed the design

This is why AC 6 asks for numbers rather than a claim. Every one of these was invisible to reading
the CSS and to looking at the render; each was found by sampling the painted pixel.

**A · The BASE fill fails AA in dark today — and it is a shipped defect, not a new one.**
`PlanWithAILauncher.HERO_STYLE` paints
`linear-gradient(135deg, var(--el-accent), color-mix(in srgb, var(--el-accent) 55%, var(--el-highlight)))`.
The label spans the whole pill, so it also sits on the FAR stop — which is 45% brand pink. Measured
over the worst pixel under the glyphs: **4.64:1 light and 3.98:1 dark**. The dark figure is below
the 4.5:1 bar, on the product's headline control, today, on `main`.
It also contradicts this very file, which says _"the brand pink lives only in the glow/aura, never
under text"_ — true of the aura, false of the fill's second stop.
**The remedy is one number and it restores the sentence rather than rewriting it**: the far stop
becomes `color-mix(--el-accent 86%, --el-highlight)` — **5.97:1 / 4.64:1** — so the fill is
accent-dominant and the pink stays in the glow, exactly as promised. Sweeping the mix shows 80% is
the first passing value (4.55:1 dark); **86% is specified rather than 80% so the bar is cleared with
margin rather than met**. This is picked up by [MOTIR-4743](motir:cmtplxqtd0078hvn8s6fzv4wa), which
rewrites that declaration anyway to move the fill off the inline `style` prop — the two are one edit,
which is why this is recorded here and on that card rather than filed as a third.

**B · Retrofuturism's SPECULAR STREAK was the failure, not the bevel.** The first draft of this
section blamed the bevel highlight and bounded it; the render then measured **2.55:1 light / 2.22:1
dark**, because the diagonal streak at `--retro-spec` (44% white) crosses the label across the full
box. **Thinning it does not rescue it** — at 18% it still measures 3.67:1 in dark, and by then the
chrome has stopped reading. So the streak becomes a **crown** highlight: its own background layer at
`background-size: 100% 28%`, above the cap height. The label sits on the bevel body at **6.76:1 /
5.16:1**, and the chrome still reads, because a machined bevel IS a vertical light-to-dark ramp with
a highlight on the crown. _(The bevel was never the problem; a plausible diagnosis measured wrong.)_

**C · A style sheen over the ORB silently breaks the guarded contrast knob.** The rule above says a
style composes OVER the lit-sphere fill rather than replacing it — and composing a LIGHT layer over
it is the same failure by another route. Glassmorphism's `--glass-sheen` and Retrofuturism's crown,
applied across the whole circle, measured **3.17:1 / 2.67:1** and **3.34:1 / 2.78:1** inside the
26/56 glyph box: under the 3:1 floor `tests/theme/orb-glyph-contrast.test.ts` enforces, from a
design that had just written down the rule it was breaking. **So the rule has a second clause: an orb
material layer is confined to the CROWN** (`background-size: 100% 20–26%`), above the glyph box,
which is why both now measure the shipped 3.78:1 / 3.10:1 — identical to no sheen at all, because
the glyph box never sees it.

**D · Glassmorphism cannot be as frosted as this sheet used to draw it.** The retired `.hc-glass`
painted `rgba(255,255,255,0.18)` — a _white_ veil — over a vibrant stage. Measured against the light
page that is **2.31:1** at a 50% accent share and **4.49:1** at 82%: below the bar, and the second
only just, which is exactly the value a designer would accept by eye. The frost is specified as
**`color-mix(in srgb, var(--el-accent) 86%, transparent)`** — still genuinely translucent, with the
glass read carried by the blur + `--glass-rim` + the inner sheen rather than by thinning the fill.
**86% is a floor, not a preference**: white is the lightest backdrop the light theme can put behind
it (`--el-page-bg` is `#ffffff`), so 86% accent composited over anything is **≥ 4.87:1**.

#### ⚠️ Row 8 reconciled — `3d-immersive` ADDS NOTHING to the shadow (AC 4)

`3d-immersive` is the one style that already treats this control, and the rule below
is written to **compose with** that rather than replace it.

`PlanWithAILauncher.HERO_STYLE` and `PlanWithAIFab.ORB_STYLE` paint `box-shadow`
**inline**, which beats every stylesheet rule — so MOTIR-3522 made each read
`var(--plan-hero-shadow, <the base look>)` / `var(--plan-orb-shadow, …)`, and
`theme.css:1688-1701` sets those two variables for this style **on `body` inside the
`@scope`**, adding the physical key's base edge (`0 4px 0 0 var(--el-accent-pressed)`,
`0 5px 0 0` for the orb).

**Therefore the `3d-immersive` rule in this section sets NO `box-shadow` and NO
`background-image`.** Two reasons, and both are rules rather than taste:

1. A `box-shadow` here would lose to the inline declaration anyway — that is the
   whole reason the variable seam exists. The correct place to change this style's
   hero depth is the existing `--plan-hero-shadow` / `--plan-orb-shadow` block.
2. `docs/styles/3d-immersive.md` §4 classifies a hero CTA as a **physical key**
   (_"An interactive pill that is an ACTION rather than a status … is a key and says
   so with `data-depth='key'`"_), and §4b's CLOSURE RULE makes an unclassified
   surface a spec defect. Both controls already carry `data-depth="key"`. Replacing
   the key's base edge with a decorative fill would take the control OFF the plane
   ladder while leaving it declared on it — a contradiction, not a restyle.

So row 8 is deliberately the base fill: under `3d-immersive` the hero's _identity_
is its depth, and the depth already ships.

#### The CSS, verbatim — copyable into `theme.css` (AC 3)

> **⚠️ AMENDED 2026-09-06 (MOTIR-4743) — TWO DECLARATIONS BELOW DO NOT WORK AS
> WRITTEN, and the shipped section transcribes them onto the seam.** The two
> components declare exactly two things in an inline `style` prop —
> `background-image` and `box-shadow` — and an inline declaration beats every
> stylesheet rule. So a `background-image` OR a `box-shadow` written in a
> `[data-style]` rule for these controls is **inert**, which is the defect this
> whole section exists to close. Both are read through a `var()` seam instead:
> `--plan-hero-fill` / `--plan-orb-fill` (MOTIR-4743) and
> `--plan-hero-shadow` / `--plan-orb-shadow` (MOTIR-3522, and the mechanism row 8
> below already relies on). A rule on the shared `[data-surface='ai-cta']`
> selector sets BOTH shadow names, since each control reads only its own.
>
> **The values below are unchanged and are still the specification** — every AA
> ratio in the table above was measured on exactly these declarations, and
> `tests/theme/aiCtaStyleSeam.test.ts` compares this block against the shipped
> stylesheet declaration for declaration, applying that one translation. What
> changed is only which PROPERTY NAME carries each value.
>
> **The shadow half was found by a RENDER, not by a reading.** Transcribed
> literally, `tests/e2e/hero-ai-control-styles.spec.ts` reported exactly one
> control identical to the base — the **aurora orb**, the only row that sets
> nothing but a shadow. Every other style also moves a fill, a border or the
> type, so its rule "worked" while its shadow silently did not.

Paste with that translation. It follows the file's own `@scope` house form (the same one the
glassmorphism, aurora, neumorphism and retrofuturism material layers use), reads
only `--el-*` and the styles' own palette-agnostic scalars, and names no raw hex.
It belongs **after** each style's token block, with the other material-layer rules —
**never inside a bare `[data-style]` token block**, which `tests/theme/styleRegistry.test.ts`
holds colour-free and `tests/theme/shapeSwapLint.test.ts` requires to override every
shape role.

```css
/* ── The hero AI control, per style (MOTIR-4742) ──────────────────────────
   The two controls that summon the planning workspace — the header pill
   (`PlanWithAILauncher`) and the floating M orb (`PlanWithAIFab`) — are the
   product's headline affordance and the sanctioned exception to the flat-button
   norm. Each style gives them its own material.

   `data-ai-cta` distinguishes the two because they do not share a fill recipe:
   the orb's `radial-gradient` first stop is `--orb-lit-mix`, a guarded contrast
   knob (MOTIR-3207), and a shared `background-image` would overwrite it. Radius,
   padding and height are NOT set here — they already flow through
   `--radius-badge` / `--spacing-btn-x` / `--height-btn-md`. Palette-derived
   throughout; the colour axis stays disjoint. */

/* 2 · Soft / Playful — pillowy stacked shadow, no border. */
@scope ([data-style='soft-playful']) to ([data-style]) {
  [data-surface='ai-cta'] {
    font-weight: 800;
    box-shadow:
      0 7px 0 -1px color-mix(in srgb, var(--el-accent) 22%, var(--el-page-bg)),
      0 14px 22px -6px color-mix(in srgb, var(--el-accent) 55%, transparent);
  }
}

/* 3 · Swiss / Minimal-Flat — flat solid, sharp, uppercase, NO shadow. */
@scope ([data-style='swiss-minimal-flat']) to ([data-style]) {
  [data-surface='ai-cta'] {
    box-shadow: none;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    background-image: none;
    background-color: var(--el-accent);
  }
}

/* 4 · Glassmorphism — frosted translucency over the rim. 86% is a FLOOR. */
@scope ([data-style='glassmorphism']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 1px solid var(--glass-rim);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    box-shadow:
      inset 0 1px 0 var(--glass-rim),
      0 8px 22px -6px color-mix(in srgb, var(--el-accent) 45%, transparent);
  }
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    background-image: none;
    background-color: color-mix(in srgb, var(--el-accent) 86%, transparent);
  }
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    /* Crown-confined: across the whole circle this sheen lightens the
       26/56 glyph box to 3.17:1 light / 2.67:1 dark and breaks the
       `--orb-lit-mix` floor the style layer may not touch. */
    background-size:
      100% 20%,
      100% 100%;
    background-position:
      top left,
      top left;
    background-repeat: no-repeat;
    background-image:
      linear-gradient(160deg, var(--glass-sheen), transparent 90%),
      radial-gradient(
        circle at 33% 27%,
        color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)),
        var(--el-accent) 56%,
        color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight))
      );
  }
}

/* 5 · Neo-Brutalism — hard 2px border + zero-blur offset shadow. */
@scope ([data-style='neo-brutalism']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 2px solid var(--el-text);
    box-shadow: 4px 4px 0 0 var(--el-text);
    font-weight: 800;
    text-transform: uppercase;
  }
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    background-image: none;
    background-color: var(--el-accent);
  }
}

/* 6 · Cybercore / Y2K — dark HUD ground, neon halo, mono label. */
@scope ([data-style='cybercore-y2k']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 1px solid color-mix(in srgb, var(--el-highlight) 70%, transparent);
    box-shadow:
      0 0 10px color-mix(in srgb, var(--el-highlight) 60%, transparent),
      0 0 26px -4px color-mix(in srgb, var(--el-accent) 70%, transparent);
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    background-image: linear-gradient(
      135deg,
      color-mix(in srgb, var(--el-accent) 88%, black),
      color-mix(in srgb, color-mix(in srgb, var(--el-accent) 70%, var(--el-highlight)) 78%, black)
    );
  }
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    background-image:
      linear-gradient(
        160deg,
        color-mix(in srgb, var(--el-highlight) 22%, transparent),
        transparent 55%
      ),
      radial-gradient(
        circle at 33% 27%,
        color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)),
        var(--el-accent) 56%,
        color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight))
      );
  }
}

/* 7 · Aurora — lit from within, colour halo, no hard shadow. */
@scope ([data-style='aurora']) to ([data-style]) {
  [data-surface='ai-cta'] {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--el-accent-text) var(--aurora-sheen), transparent),
      0 0 26px -2px color-mix(in srgb, var(--el-accent) var(--aurora-glow), transparent),
      0 0 40px -6px color-mix(in srgb, var(--el-highlight) var(--aurora-glow), transparent);
  }
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    background-size:
      100% 28%,
      100% 100%;
    background-position:
      top left,
      top left;
    background-repeat: no-repeat;
    background-image:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--el-accent-text) var(--aurora-sheen), transparent),
        transparent 90%
      ),
      linear-gradient(
        135deg,
        var(--el-accent),
        color-mix(in srgb, var(--el-accent) 86%, var(--el-highlight))
      );
  }
}

/* 8 · 3D / Immersive — NOTHING. `--plan-hero-shadow` / `--plan-orb-shadow`
   own this control's depth and the components read them through a `var()`
   seam an inline `box-shadow` would otherwise beat (MOTIR-3522). A rule
   here would either lose to that inline declaration or take a
   `data-depth="key"` control off the plane ladder it is declared on
   (docs/styles/3d-immersive.md §4 / §4b). Deliberately empty — recorded so
   the absence reads as a decision, not an omission. */

/* 9 · Hand-Drawn / Indie — a drawn ink outline + a hand-placed offset. */
@scope ([data-style='hand-drawn-indie']) to ([data-style]) {
  [data-surface='ai-cta'] {
    position: relative;
    font-weight: 700;
    box-shadow: 3px 4px 0 -1px color-mix(in srgb, var(--el-border-strong) 55%, transparent);
  }
  [data-surface='ai-cta']::after {
    content: '';
    position: absolute;
    inset: -1px;
    pointer-events: none;
    border: 2px solid var(--el-border-strong);
    border-radius: inherit;
    filter: url(#hd-rough);
  }
}

/* 10 · Neumorphism — moulded, NOT raised-and-glowing: no gradient, no
   glow, and the hairline is KEPT (structure never relies on shadow alone). */
@scope ([data-style='neumorphism']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 1px solid color-mix(in srgb, var(--el-accent) 70%, var(--el-text));
    box-shadow:
      var(--neu-distance) var(--neu-distance) var(--neu-blur) var(--neu-shadow),
      calc(var(--neu-distance) * -1) calc(var(--neu-distance) * -1) var(--neu-blur) var(--neu-light);
  }
  [data-surface='ai-cta'][data-ai-cta='pill'],
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    background-image: none;
    background-color: var(--el-accent);
  }
}

/* 11 · Retrofuturism — a chrome bevel + a CROWN-CONFINED specular streak.
   ⚠️ THE STREAK IS THE THING THAT HAD TO MOVE, not the bevel. Across the
   full box the diagonal at `--retro-spec` washes the label to 2.55:1 light
   / 2.22:1 dark, and thinning it does not rescue it (18% still measures
   3.67:1 dark, by which point the chrome has stopped reading). Sized to
   the top band it sits above the cap height, the label sits on the bevel
   BODY at 6.76:1 / 5.16:1, and the chrome still reads — a machined bevel
   IS a vertical light-to-dark ramp with a highlight on the crown. */
@scope ([data-style='retrofuturism']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 1px solid color-mix(in srgb, var(--el-accent-text) 30%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--el-accent-text) var(--retro-bevel-light), transparent),
      0 0 24px -4px color-mix(in srgb, var(--el-accent) var(--retro-glow), transparent);
  }
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    background-image:
      linear-gradient(
        104deg,
        transparent 30%,
        color-mix(in srgb, var(--el-accent-text) var(--retro-spec), transparent) 46%,
        transparent 62%
      ),
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--el-accent) 82%, white) 0%,
        var(--el-accent) 20%,
        color-mix(in srgb, var(--el-accent) 84%, black) 100%
      );
    /* The specular streak is a CROWN highlight, sized to the top band alone.
       Across the whole box it washes the label to 2.55:1 light / 2.22:1 dark —
       and thinning it does not rescue it (18% still measures 3.67:1 in dark).
       Confined above the cap height the label sits on the bevel BODY, and the
       chrome still reads, because a machined bevel IS a vertical light-to-dark
       ramp with a highlight on the crown. */
    background-size:
      100% 28%,
      100% 100%;
    background-position:
      top left,
      top left;
    background-repeat: no-repeat;
  }
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    /* Crown-confined, for the same reason as glass: unbounded it measures
       3.34:1 light / 2.78:1 dark inside the glyph box. */
    background-size:
      100% 26%,
      100% 100%;
    background-position:
      top left,
      top left;
    background-repeat: no-repeat;
    background-image:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--el-accent-text) var(--retro-bevel-light), transparent),
        transparent 90%
      ),
      radial-gradient(
        circle at 33% 27%,
        color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)),
        var(--el-accent) 56%,
        color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight))
      );
  }
}
```

**Warm Editorial (row 1) has no block by design** — it is the Tier-0 base, and the
components' own `var()` fallbacks ARE its treatment. A block repeating them would be
a second copy to drift. **Its FILL still changes, and not here:** finding A moves the
base gradient's far stop to `86%`, which is an edit to
`PlanWithAILauncher.HERO_STYLE` itself, not a `[data-style]` rule. Ten styles inherit
that stop, so it is the one value in this section that is not optional for any of
them.

#### What this section does NOT decide

- **It does not emit the hook.** `data-surface` / `data-ai-cta` on the two
  components, and moving the fill off the inline `style` prop so a rule can reach it,
  are MOTIR-4743's work. This section is the specification that card copies.
- **It does not change `--orb-lit-mix`, `--plan-hero-shadow` or `--plan-orb-shadow`.**
  All three ship and all three are read, not rewritten.
- **It DOES change the base gradient's far stop** (finding A), because leaving it would
  ship ten of the eleven rows below the AA bar in dark. That edit is a component change
  and belongs to [MOTIR-4743](motir:cmtplxqtd0078hvn8s6fzv4wa) with the rest of the fill
  work — recorded here, and on that card, so the card that rewrites the declaration
  cannot rewrite it back to `55%`.
- **It does not touch the shimmer or the pulse.** Both are `globals.css` animations
  already gated behind `prefers-reduced-motion`, and neither is style-axis work.

### ⚠️ Opening & exiting — a full-screen overlay ON TOP of the app (sheet 6)

> **⚠️ AMENDED 2026-09-06 — MOTIR-4726, under story [MOTIR-4725](motir:cmtpk3r2z0096hvn8v7lav9wi).**
> This section said the right thing and drew nothing a code card could build to. What ships today
> is a **route** — `app/(planning)/layout.tsx` + `planning/page.tsx`, the host MOTIR-1729 built,
> whose own header says why: _"The design's overlay keeps the origin screen mounted behind it;
> this host is a ROUTE (the card's deliverable), so 'returns you to where you launched from' is a
> navigation back to that route."_ The amendment does not change the sentence below; it draws it
> as the parts the product NOW HAS — the shipped `Modal size="full"`, its scrim, `shallowPush`,
> and the run modal (`design/runs/` § _The run MODAL_) that already answered the two-`Esc`
> question — and it settles the three things no code card can settle for itself: the overlay's
> **address**, the Close control's **copy**, and what happens on **close-with-pending**.
> **What is superseded, explicitly: the "slight inset + drop shadow" clause. The dialog is EDGE
> TO EDGE.** Everything else here stands.

The workspace **covers the screen** (the canvas + chat need the room) but it is a
**full-screen overlay LAYERED ON TOP of the PM app — not a route change**. The app
stays mounted, dimmed + inert, behind it. **Closing returns you to the
exact screen you launched from** (same route, scroll, filters) with **no reload or
lost state** — so it is "full-screen" for working AND "on top" for context.

#### The FRAME — the shipped `Modal size="full"`, edge to edge

The dialog is `components/ui/Modal.tsx` (the i18n shim) over
`packages/design-system/src/components/ui/Modal.tsx`, at `size="full"`, with the panel chrome
removed exactly as `RunModal.tsx` removes it: `className="flex flex-col rounded-none border-0 p-0"`.
Inside it is the shipped `PlanningWorkspaceHost` — its frame, its exit-chrome row, its audit-banner
slot, its canvas box and its footer slot are **COMPOSED, never redrawn**.

**MEASURED, on those components rendered headless** (chromium, light, `deviceScaleFactor: 1`,
`Modal size="full"` wrapping the real `PlanningWorkspaceSkeleton`) — not computed from the
class strings:

|                                             | 1440×780                                                   | 1024×648                   |
| ------------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| dialog box (radius **0px**, border **0px**) | 1440×780                                                   | 1024×648                   |
| scrim                                       | full viewport, `--el-overlay-scrim` = `rgba(0, 0, 0, 0.4)` | same                       |
| `grid-cols-[1fr_22rem]` — canvas · rail     | **1088** · 352                                             | **672** · 352              |
| the host's own exit-chrome bar              | 49                                                         | 49                         |
| **canvas pane, EDGE TO EDGE**               | **1088×780**                                               | **672×648**                |
| canvas pane with a 24px inset + shadow      | 1040×732                                                   | 624×600                    |
| what the inset costs                        | −48 × −48                                                  | −48 × −48 (−7.4% of width) |

**THE DECISION IS EDGE TO EDGE**, for three reasons in the order that decided it:

1. **An inset is a REGRESSION against what ships.** The route host is already `h-dvh w-full` with
   no shell chrome, so the edge-to-edge overlay hands the canvas the _identical_ box and an inset
   takes 48px in each axis off it. A migration that makes the surface smaller is not a migration.
2. **`design/roadmap/`'s fit-floor work (MOTIR-3837) fought for +120px** of canvas height at
   1440×900 on the surface with the most canvas need. Giving 48 of that back to a margin is that
   argument running backwards.
3. **The "it is a layer on top" reading is carried by the SCRIM over a still-visible host page**
   and by the open animation — not by a 24px margin. `RunModal` made this call in this same
   primitive for this same reason: _"at full size the dialog IS the surface."_

> **The sheet draws the dialog inset by 22px anyway, and says so on the panel.** The shipped
> dialog covers the viewport exactly, which would hide the host page the sheet exists to show is
> still mounted — so every pane offsets it and marks the real edge with a dashed accent box
> labelled _"the dialog's REAL edge — 0px inset, 0px radius"_. **The inset is a drawing device;
> the spec is 0.**

**`hideClose` — the dialog's corner ✕ is SUPPRESSED.** Measured at 1440: it renders at
`(1404, 12)`, 24×24, top-RIGHT, while `PlanningWorkspaceHost` renders its own Close top-LEFT.
Two Closes in one dialog is a question the reader should never be asked, and the host's is the
one sheet 6 has always specified. (`RunModal` keeps the corner ✕ because it has no other.)

#### The way OUT — four exits, one path

**The shell carries its OWN exit chrome** (it has no app nav to leave through), and all four
exits run the same code:

| exit             | what it is                                                 | note                                                                                                                          |
| ---------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Close**        | the control **top-LEFT** of the workspace                  | a plain **Close** — see the copy decision below                                                                               |
| **`Esc`**        | the **DIALOG's** handler (Radix)                           | the host's own `keydown` listener is DELETED                                                                                  |
| **the scrim**    | a click on the dimmed page outside the dialog              |                                                                                                                               |
| **browser Back** | a `popstate` that no longer carries the overlay parameters | works because the address was a `shallowPush`, so it left a history entry; closing from it writes **no second** history entry |

One path: `requestClose()` → `withoutPlanningOverlay(currentHref)` → `shallowPush`. **The host page
underneath is never unmounted**, so its filter, its scroll, its selection and its client islands
survive the round trip. Focus returns to the element that was active at open (Radix's own
behaviour, and the reason the doors do not have to manage it).

**THE CLOSE CONTROL'S COPY — a plain `Close`, and the message key is `planningWorkspace.close`.**
Today's label is `Back to roadmap` / `Back to {item}` / `Back to code health`
(`messages/en.json` `planningWorkspace.backTo*`) because a ROUTE had to name a destination. **An
overlay has no destination — it returns you to where you already are**, and naming a page you are
not going to is worse than saying nothing. So: `Close`, with the `Esc` chip beside it, unchanged
in placement. **The three `backTo*` keys are DELETED** in both `messages/en.json` and
`messages/zh.json` by the overlay card, which also adds `planningWorkspace.close`; the launcher
card retires `planningLaunchBackHref`, which is their only producer.

**THE `Esc` ARBITRATION IS A DECISION, not a default.** `ProjectRoadmapCanvas` ships an opt-in
`fullScreenable` control (a Fullscreen-API escalation), and it is **OFF inside the overlay** —
the run modal's decision verbatim, for the same reason: _"escalating to the Fullscreen API from
inside a dialog that already fills the screen is two overlays and two `ESC` handlers."_ And the
host's own `Esc` listener — which yielded to a focused text field, to `document.fullscreenElement`
and to a `defaultPrevented` event — is **removed**: Radix owns the key, and a text field inside a
dialog still keeps it, because Radix's own handler is the one that yields.

#### The ADDRESS — a NAMESPACED query, settled here because three cards read it

The workspace opens on ANY authed route, so its query rides beside the host page's own. Measured
collisions at `origin/main` `71896757c`: **`?item=`** on `/roadmap` is the drilled LEVEL
(MOTIR-3836, `resolveArrivalTrail`); **`?peek=`** is the quick view on `/items`, `/ready`,
`/boards`; **`?run=`** is the run modal; and today's launcher writes the four generic names
`mode`, `from`, `item`, `repo` (`lib/planning/launcher.ts` `planningWorkspaceHref`), two of which
collide outright. So the overlay's parameters are **NAMESPACED**, and they are recorded here once —
the way `design/runs/design-notes.md` records `/runs?run=<id>` — rather than in whichever of the
three files is written first.

| parameter         | carries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | values                                                                     | read by                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| **`plan`**        | **the presence switch AND the mode.** Its presence is what opens the overlay — one `has('plan')` test, the way `?run=` and `?peek=` each own one word. Total: an unrecognised value degrades to `project`, never an error                                                                                                                                                                                                                                                                                                           | `project` · `generation` · `replan` · `contextual` · `roadmap`             | the overlay                           |
| **`planFrom`**    | the ORIGIN kind. It is what decides which of the two below may be READ, so a hand-edited `?planFrom=roadmap&planItem=X` cannot smuggle a target                                                                                                                                                                                                                                                                                                                                                                                     | `project` · `work-item` · `roadmap` · `convention-refine` · `refused-gate` | the overlay · the rail's opening line |
| **`planItem`**    | the ANCHOR's work-item key. Written **only** when `planFrom=work-item`; the overlay hands it to `GET /api/work-items/planning-anchor` (MOTIR-4727)                                                                                                                                                                                                                                                                                                                                                                                  | `MOTIR-<n>`                                                                | the overlay                           |
| **`planSession`** | a SESSION's id — reopens that planning conversation by id, the window notwithstanding (MOTIR-6019's published design, §19.8; built by MOTIR-6024). Read only when `plan` is present and `planFrom` is `project` or `work-item`                                                                                                                                                                                                                                                                                                      | a session id                                                               | the overlay                           |
| **`planVia`**     | the ENTRANCE a named session was reopened from, so the rail's reopened line tells the truth (MOTIR-6033's landed design — `design/ai-planning/design-notes.md` Part XXII §22.2; built by MOTIR-6037). Read only with `planSession`; absent, or any other value, means the Plans page                                                                                                                                                                                                                                                | `plans` · `approvals`                                                      | the rail's reopened line              |
| **`planGate`**    | a REFUSED GATE's id — opens the SEEDED re-plan (story MOTIR-6068; MOTIR-6206's design, § _The SEEDED re-plan_ → _The ADDRESS_; built by MOTIR-6210). Written **only** when `planFrom=refused-gate`, as `plan=replan&planFrom=refused-gate&planGate=<id>`; the overlay hands it to `GET /api/approval-gates/{id}/planning-seed` (MOTIR-6208). The gate's id and nothing else — never the reason, never a title                                                                                                                       | a gate id                                                                  | the overlay                           |
| **`planStart`**   | START THE CONVERSATION — the overlay SENDS the anchor's start turn (`Plan <KEY>`, `planningWorkspace.startTurn.plan`) once, for the person, as the thread's first message (story MOTIR-5266; MOTIR-7875's design, `design/ready/design-notes.md` § _Expand starts a planning conversation_; built by MOTIR-7973). Written **only** when `planFrom=work-item` with `planItem` and no `planSession`, and read only there. After the first turn the host REPLACES it with `planSession=<id>`, so a reload resumes and never asks again | `1`                                                                        | the overlay                           |
| **`planOffer`**   | a GUIDE RE-PLAN OFFER's turn id — opens the planner SEEDED from the offer (story MOTIR-8684; the sheet 9 surface above; built by MOTIR-8693). Written **only** when `planFrom=guide-offer`, as `plan=contextual&planFrom=guide-offer&planOffer=<turnId>`; the overlay hands it to `GET /api/ai/guide/offer/{turnId}/planning-seed` (MOTIR-8692). The offer's turn id and nothing else — never the request text, a key or a title                                                                                                    | a guide turn id                                                            | the overlay                           |

**Why the mode rides on `plan` rather than on a fifth name.** The overlay needs ONE parameter
whose mere presence means _open_, exactly as `?run=` and `?peek=` do; the mode is already total
(anything unrecognised falls back to `project`), so it can ride that key without a second
degradation path. It makes "is the overlay open?" one call and `withoutPlanningOverlay` a strip of
exactly four names. The camelCase of the other three matches `?parentId=`, the tree's existing
multi-word query parameter.

**Three files agree on these four names, and none of them should be the one that picks them:**
the launcher module WRITES and PARSES them, the overlay READS them off `useSearchParams`, and the
retiring `/planning` forward REWRITES the old `mode` / `from` / `item` / `repo` onto them.
Renaming one is a change to this section first.

**Close strips exactly these eight (four until MOTIR-6024 added `planSession`, five until MOTIR-6037 added `planVia`, six until MOTIR-6210 added `planGate`, seven until MOTIR-7973 added `planStart`, eight until MOTIR-8693 added `planOffer`, nine until MOTIR-9090 retired `planRepo` with the convention launcher) — nine with the `planReturned` marker — and leaves every other parameter byte-identical** — that is what
makes "back to exactly where you were" true of a filtered, scrolled list rather than only of a
bare route. `withPlanningOverlay('/roadmap?item=MOTIR-12', …)` keeps `item=MOTIR-12`;
`withoutPlanningOverlay` of the result returns it unchanged, with no dangling `?`.

**Arriving COLD.** An address carrying the overlay query, pasted into a new tab: the **host page
renders first and the overlay opens over it** — the same order `?run=` produces, and the reason
the address is worth pasting at all. Nothing is server-rendered for the overlay; it reads the
query on the client and fetches its own anchor.

**Arriving SIGNED OUT.** The sign-in hop carries the **whole address** — host path AND overlay
query — in `next=`, so signing in lands on the backlog with the workspace already open over it,
not on the backlog with the workspace lost. Same rule as every other authed deep link; it is
stated here because the overlay is the first surface whose STATE is in the query rather than in
the path.

**LAUNCHED FROM INSIDE THE QUICK VIEW — the dialog-over-dialog case, DECIDED: the workspace opens
ABOVE the peek and the peek STAYS in the URL.** The per-item Plan / Re-plan pill (MOTIR-910,
design MOTIR-1489) renders inside the `?peek=` quick view, which is itself a URL-driven modal, so
`/items?peek=MOTIR-12` gains the overlay's four parameters and keeps its own. Closing the
workspace therefore returns the reader to the **open peek** they launched from, which is the
literal reading of "back to exactly where you were" — the peek IS where they were. Dismissing the
peek first would be a second, silent close the reader did not ask for, and it would make this one
door behave unlike the other six. **The doors card builds one behaviour, not two.**

#### The CLOSE-WITH-PENDING guard

Because **confirm-to-persist** means nothing is saved until Confirm, dismissing with proposed
(pending) cards opens a guard: **Discard N proposed · Keep planning · Confirm & add** — never a
silent loss. It was specified here from the start and never built (`grep -n 'Discard\|Keep planning'
components/planning lib/hooks` returns nothing at `6cb6d0eef`).

**What it is:** the shipped `Modal` with **`role="alertdialog"`** — the destructive-confirm
precedent, Subtask 2.8.4 — over the workspace, over the host page. Three shipped `Button`
variants: **Confirm & add** primary, **Keep planning** secondary, **Discard N proposed** the
danger action (`bg-(--el-danger) text-(--el-danger-text)`, the one legal use of that ink).
**The count is IN the copy**, because "discard the proposals" and "discard 5 work items you just
watched appear" are different sentences.

**The pending predicate is the HOST's own, not a second one:**
`state.review && !state.decided && !index.isEmpty` — the exact expression
`PlanningWorkspaceHost` already uses to decide whether `PlanChangeConfirmBar` is showing. **If the
bar is up, the guard fires; if it is not, closing is instant.** The reader can see the rule, which
is what makes it feel like a rule rather than a surprise.

**The VECTORS, and what each can do:**

| vector                 |                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Close ✕**            | INTERCEPTED — nothing closes until an action is chosen                                                                                                                                                                                                                                                                                   |
| **`Esc`**              | INTERCEPTED. The guard's OWN `Esc` then dismisses the **guard**, never the workspace                                                                                                                                                                                                                                                     |
| **the scrim**          | INTERCEPTED, same as Close                                                                                                                                                                                                                                                                                                               |
| **browser Back**       | **ALREADY HAPPENED.** A history pop cannot be prevented — by the time the overlay notices, the address no longer carries the query. So the guard opens over a workspace whose address has already changed, and **_Keep planning_ RE-PUSHES the overlay address** with one `shallowPush`; _Discard_ and _Confirm & add_ let the pop stand |
| **a streaming turn**   | **NOT guarded.** A turn still streaming has produced no proposal to lose — the predicate needs a `review`, and a stream has none yet. Closing calls the conversation's `stop` and the turn is abandoned, which is exactly what navigating away did                                                                                       |
| **reload / tab close** | **NOT guarded — no `beforeunload`.** A browser's own "leave site?" dialog cannot carry these three actions, so it would be a strictly worse version of this one, and it fires on every reload whether or not there is anything to lose                                                                                                   |

**_Keep planning_ leaves the proposal intact and returns focus to the workspace. _Discard_ calls
the host's `discard` and then closes. _Confirm & add_ calls `approve`, shows the deciding state,
closes on success and STAYS OPEN on failure** — a failed approve is the one case where closing
would lose the thing the reader was trying to save.

#### Every state — not the happy path

| state                    | what it draws                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opening**              | `PlanningWorkspaceSkeleton` INSIDE the dialog. It is the frame `app/(planning)/loading.tsx` used to be; as an overlay there is no navigation to hold, so the frame is up on the first frame and the canvas fills in |
| **Empty canvas**         | the canvas's own empty statement, unchanged (`emptyCanvasTitle` / `emptyCanvasDescription`)                                                                                                                         |
| **No access**            | the host's `NoAccessState` statement, then the overlay **closes** and the page underneath reports — the run modal's `missing` shape                                                                                 |
| **Never onboarded**      | a real navigation to `ONBOARDING_ENTRY_PATH`, with the overlay query **stripped**. Onboarding is this design's one stated exception — a dedicated first-run journey, not a dismissable overlay                      |
| **Anchor won't resolve** | the project conversation, at the root, **with no error surface**. A `404` from the anchor read is the no-existence-leak answer for stale, deleted, foreign and forbidden alike (MOTIR-4727)                         |
| **Audit banner**         | admin: `AuditCoverageBanner` full-bleed in the seam between the top bar and the panes — CITED from MOTIR-2246 / `design/audit-coverage`, never redrawn. Member: nothing, and no reserved gap                        |
| **Proposal pending**     | the footer SLOT swaps CONTENT, never height — the canvas box must not resize under the zoom / fit / LOCATE clusters anchored to its bottom (MOTIR-1815 panel 3)                                                     |
| **Streaming**            | the rail's own streaming state, unchanged; the composer's `stop` is what a close calls                                                                                                                              |
| **Host page behind**     | filter · scroll · selection all preserved, because nothing unmounted. **This is the state the whole story is for, and it is a state of the page UNDER the overlay**                                                 |

#### The ACCESS PATH — the doors are cited, not redrawn

The doors are all designed and shipped: the header pill and the orb (sheet 4 of this asset), the
callout menu (MOTIR-1811, `ai-callout-menu.mock.html`), the per-item Plan / Re-plan pill
(MOTIR-1489), ⌘K, the roadmap's empty state, and Code health's _Refine with Motir_ (MOTIR-1663).
**What changes is what they OPEN.**

> **Every door opens the overlay on the page it sits on; none navigates.**

Sheet 6 draws ONE before/after — the header pill on a filtered backlog, then the overlay over that
same backlog — and the addresses under each. **A modified click (⌘ / ctrl / middle) is never
intercepted**, so each door's `href` stays a real, full address that opens the overlay in a new
tab.

#### The ALLOCATION SWEEP — GIVES / TAKES

Every work item this asset names, and what the asset hands it or takes from it. **A TAKES is an
amendment owed on that card in this same pass** (`plan-rules/type-design.md`'s sweep-the-referrers
corollary).

| work item                                                                                                                                                | GIVES / TAKES                   | what                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MOTIR-4728](motir:cmtpk3ra80099hvn8woe5fkvg) — the launcher writes an overlay address                                                                   | **GIVES · STRUCTURE**           | the four parameter names and their write/read rules, including the origin-gated `planItem` / `planRepo`. Its criteria already say _"emits exactly the parameter names `design-notes.md` records"_, so this section is the thing that test reads |
| MOTIR-4728                                                                                                                                               | **TAKES · PREMISE**             | nothing. `planningLaunchBackHref` was already scheduled for `@deprecated` there and its retirement is unchanged                                                                                                                                 |
| [MOTIR-4729](motir:cmtpk3rcp009ahvn8v0fmz7uf) — the overlay host                                                                                         | **GIVES · ELEMENT**             | `hideClose`, the edge-to-edge className, the Close COPY and its key name (`planningWorkspace.close`), the deletion of the three `backTo*` keys, the removal of the host's own `Esc` listener, and `fullScreenable` off with its reason          |
| MOTIR-4729                                                                                                                                               | **GIVES · STRUCTURE**           | the eight states above, and the ANCHOR degradation (a `404` is the project conversation at the root, no error surface)                                                                                                                          |
| [MOTIR-4730](motir:cmtpk3rew009bhvn8vflvtftd) — every door opens in place                                                                                | **GIVES · PREMISE**             | the quick-view decision: the workspace opens ABOVE the peek and `peek` is KEPT. Its criterion reads _"keeps or strips `peek` exactly as the design decided, and a test names that decision"_ — the decision is KEEP                             |
| [MOTIR-4731](motir:cmtpk3rgm009chvn84bn99ahq) — the pending guard                                                                                        | **GIVES · ELEMENT + STRUCTURE** | the alertdialog composition, the three button variants and the count in the copy; the six vectors; the browser-Back re-push; streaming and `beforeunload` both explicitly NOT guarded; the predicate is the host's own expression               |
| [MOTIR-4732](motir:cmtpk3rix009dhvn8o9fikxzb) — the `(planning)` route group retires                                                                     | **GIVES · STRUCTURE**           | the old→new parameter mapping the forward rewrites                                                                                                                                                                                              |
| [MOTIR-4727](motir:cmtpk3r810098hvn8pm51j2j1) — the anchor read                                                                                          | **GIVES · PREMISE**             | nothing this asset decided; the read's own 404 contract is cited, not set, here                                                                                                                                                                 |
| [MOTIR-1193](motir:cmqmsx1rm000004l2rgt8ll9z) — this asset's own `done` card                                                                             | **TAKES · PREMISE**             | the "slight inset + drop shadow" clause is superseded. **The card is `done` and is NOT re-opened** — the asset is amended and the card cited, the disposition MOTIR-3893 recorded when it reworked MOTIR-1795's asset                           |
| [MOTIR-1729](motir:cms35ia0n000w04i9411n73kf) — the route host                                                                                           | **TAKES · PREMISE**             | the ROUTE itself. Its deliverable is retired by MOTIR-4732; the card is `done` and stays so, and its own header already names this as the gap                                                                                                   |
| [MOTIR-1299](motir:cmqqeh065000004jmkc1dmtj5) · [MOTIR-1342](motir:cmqsudezn000s04k1rjwulr0l) · [MOTIR-910](motir:cmqgmjqq7000004jo4ap0vwdp) — the doors | **TAKES · nothing**             | their visual design is untouched; only what they open changes, which is MOTIR-4730's work                                                                                                                                                       |
| [MOTIR-3893](motir:cmteb0te7001mhvn8qbialic7) · [MOTIR-3895](motir:cmteb0tj2001ohvn82ijisqz7) — the run modal                                            | **GIVES to THIS asset**         | the shape, the `?run=` recording precedent, the `fullScreenable`-off decision, and _"at full size the dialog IS the surface"_                                                                                                                   |

**No card's SIZE is changed by this asset** (the estimation half of the sweep,
`plan-rules/type-design.md`). Every GIVES above lands inside a criterion that card already
carries — the four cards' own criteria each defer to "as the design records / decided" — so the
asset ANSWERS questions they were already sized to ask, rather than adding deliverables. The one
card that gains a named obligation is MOTIR-4729 (the `backTo*` deletion and the `close` key),
and its criteria already carry it verbatim.

#### The terminology sweep — `grep -oic 'card'`

**72 hits, and every one is accounted for.** 40 are `--el-card` / the `.card` class / `--radius-card`
— the design system's own surface primitive, which is what the token is called. 10 `modecard` and 6
`optcard` are this asset's own class names. 3 are `StationCard`, a shipped component quoted by name.
7 `Discard` + 1 `discards` are the guard's action verb, which is the right English word for what it
does. **The remaining 4 are in HTML / JS COMMENTS** (the file header, the MOTIR-4318 provenance note,
and one render comment) and render nowhere.

**7 RENDERED uses of the product noun were corrected in this pass**, five of them pre-existing in
sheets 1–3: _"proposed cards appear on the canvas"_, _"proposed cards land on the canvas"_, _"each
card appears as I propose it"_, _"Reply, or refine a card…"_, _"new card proposed after Invoices"_,
plus two in this amendment's own first draft. **The product noun is _work item_.**

### Primitives composed (no hand-rolling)

| Element                                            | Built from                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the workspace shell                                | the shipped `PlanningWorkspace` (`grid-cols-[1fr_22rem]`)                                                                                                                  |
| canvas pane (nodes + edges + zoom + search)        | the standalone `WorkItemCanvas` (`MOTIR-1194`; design `design/roadmap/`) over the shipped `PlanningCanvas` — composed, never redrawn                                       |
| chat rail (header + bubbles + drafting + composer) | the shipped `DiscoveryChatRail` language — `Card`/`Avatar`/`Input`/`Spinner`/`Button`                                                                                      |
| proposed (pending) node + edge                     | the canvas's `StationCard` + `PlanningCanvas` edge language in a `proposed` state (dashed `--el-accent`)                                                                   |
| confirm-to-persist bar                             | `Card` (accent border) + `Button` (Confirm primary, Discard ghost)                                                                                                         |
| "Plan with AI" hero launcher                       | NEW reusable affordance — a `Button`-based gradient pill (header) OR a floating orb (FAB), palette-derived gradient + glow + `Sparkles` + shimmer; ⌘K via `CommandPalette` |
| host context (sheet 4)                             | the real shipped `TopNav` (Option A host) + the global `AppCommandPalette` (⌘K); the FAB docks into any route                                                              |
| icons                                              | lucide-react (`Sparkles` for the launcher)                                                                                                                                 |

### Token / a11y discipline

- **Colour** strictly via `--el-*` (the mock inlines the real light-palette
  values, as the sibling canvas mocks do). The **hero launcher** is a
  palette-DERIVED gradient (`--el-accent` → `--el-highlight`) + glow — a
  sanctioned feature-surface exception (no raw hex), with the white label kept
  over the **accent-dominant** region so **AA holds** and the brand pink confined
  to the glow/aura. The proposed state uses `--el-accent` border over a faint
  accent-tinted surface + a soft pink glow; the cross-story edge is
  `--el-warning`. Work-item type hues are `--el-type-{epic,story,subtask,…}`; type
  dots/tiles put the hue in a tint with strong text (finding #35, AA).
- **Shape** strictly via element-semantic tokens (node = `--radius-card`, pills =
  `--radius-badge`, buttons = `--radius-btn`, menu/list rows = `--radius-control`,
  the palette = `--radius-modal`; shadows = `--shadow-{subtle,card,modal}`) so a
  `[data-style]` swap reshapes the whole surface. `rounded-full` only on dots /
  avatars.
- **Not colour alone** — the proposed state pairs the dashed border + a
  `proposed` pill + a label; pending edges are dashed (not just tinted); each
  mode pairs an icon + label; the launcher pairs the `✦` icon + the "Plan with
  AI" text everywhere.
- **A11y** — the canvas + chat are labelled regions (`role="application"` /
  `aria-label`, shipped on `PlanningCanvas` / the rail); the launcher is a real
  `Button` / menu `option`, keyboard-reachable; the ⌘K command follows the
  shipped palette's combobox/listbox pattern; decorative icons are
  `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface:
`design-notes.md` (this section) · `planning-workspace.mock.html` (source) ·
`planning-workspace.png` (full-page export, Playwright chromium — light,
`deviceScaleFactor: 2`, 1200px wide — re-export with
`node scripts/render-design-mock.mjs … --width 1200 --height 900`, passing both
explicitly per MOTIR-4374); `prettier --check` clean. **Colour is on the `--el-*`
token layer at every paint site** (MOTIR-4428 — see the amendment above; before
that sweep this clause would have been false of everything except the orb). Grounded in
`7.4`/`7.11`/`7.12`/`7.19` (the modes) + `7.20.3`/`MOTIR-1299` (the launcher it
gates); supersedes `MOTIR-898` + `MOTIR-907`.

---

## @-mention work-item picker in the planning chat (MOTIR-1490)

Design for the **@-mention work-item target picker** inside the universal
planning workspace's chat composer — MOTIR-1490, design subtask of
MOTIR-812 (Contextual planning from each work item). The user must be able to
**search/locate a work item and reference it as the planning/re-planning TARGET**
in the chat — like Claude Code's `@ a file` — so the planner sees the target(s)
in the conversation. **Multiple targets** supported.

Grounded in the workflow-defining subtasks (the design-content dependency rule):
**MOTIR-909** (contextual session — the session accepts ONE OR MORE target ids
as a target SET) + **MOTIR-1489** (entrance design — the pre-scoped target
from the entrance). The code subtask this design gates is **MOTIR-1491** (the
picker implementation).

**Asset:** `target-picker.mock.html` (source) + `target-picker.png` (full-page
export). A five-panel review board:

| Panel | What it shows                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | The `@` trigger — typing `@` in the chat composer opens a search dropdown over the project's work items; each result shows kind icon · key · title · status Pill; type-to-filter; keyboard (↑/↓/Enter/Esc)                                                               |
| **2** | Multi-target tray — the composer above the input carries a "Targets" tray of picked-item chips (reusing the shipped `WorkItemRefChip` vocabulary); user can add several and remove any (⨉). States: empty, one target, multiple targets, the @-trigger button affordance |
| **3** | Targets in the conversation — a sent turn shows the target chips in the bubble; the map (canvas) highlights the target node(s) with the accent active ring + glow + "Target" pill                                                                                        |
| **4** | States — empty (no query: "Type to search…"), short query ("Keep typing…"), loading (spinner + "Searching…"), no-results ("No work items match 'zzqq'")                                                                                                                  |
| **5** | Pre-scoped entrance — opened from an item's Plan/Re-plan entrance (MOTIR-1489), that item is pre-filled as an initial target in the tray; the user can remove it or add more                                                                                             |

### ⚠️ COMPOSES, DOES NOT REDRAW (design-compose rule, notes #82 + #95)

Every element this surface needs already exists in shipped form; the @-picker
is an ARRANGEMENT of them, never a redesign:

- **The chat rail** = the shipped `DiscoveryChatRail.tsx` language, reproduced
  faithfully in the mock (rail head + dot + "Motir AI" label + mode chip,
  `Bubble` + `Avatar`, the composer `Input` + `Send` button). The one NEW
  element is the @-trigger + targets tray — both live above/beside the
  existing composer input.
- **The @ search dropdown popup** = the shipped work-item-search row vocabulary
  from `design/work-items/internal-links.mock.html` panel 3 (`.pop-row`:
  type-icon · mono key · title · status Pill), adapted for a chat-context
  dropdown. The search fetcher reuses the shipped
  `lib/mentions/workItemMentionSearch.ts` (`GET /api/work-items/mention-search`).
  Results are scoped to the currently active project — the same scope the
  contextual session operates in. This is NOT the Tiptap `@`-mention picker
  (`markdownEditorMentions.tsx`) — the chat composer is a plain text input,
  not a rich-text editor, so the picker is a standalone combobox dropdown.
- **The inserted chip** IS the shipped `WorkItemRefChip` (5.8 /
  MOTIR-1399, done) — `components/markdown/WorkItemRefChip.tsx`, the
  `.wi-chip` vocabulary with type icon · mono key · title. The targets tray
  COMPOSES it — never redesigns the chip. (No status dot in this context —
  a target assignment doesn't imply status relevance.)
- **The map highlight** = the shipped canvas "active" node state from
  `design/ai-chat/planning-workspace.mock.html` (`.node.active`: accent
  border + ring + glow), plus a "Target" pill above each target node so the
  user SEES which part of the plan the planner is acting on.

### How it works (grounded in the workflow spec)

1. **The `@` trigger.** Typing `@` (or clicking the @ button) in the chat
   composer opens the search dropdown. The dropdown reuses the shipped
   work-item-search fetcher debounced at N ≥ 2 characters; results carry
   kind icon · key · title · status Pill. Keyboard: ↑/↓/Enter/Esc;
   `aria-activedescendant` on the listbox.
2. **Picking a target.** Enter/click on a result adds that item's chip to the
   targets tray ABOVE the input; the dropdown closes; the input keeps focus
   so the user can continue typing the message.
3. **Multi-target.** The user can add several targets by repeating `@` →
   pick. Each chip carries a ⨉ remove button; clicking it removes that target
   from the set. The tray label reads "Target" (singular) or "Targets"
   (plural). The session API (MOTIR-909) accepts the target SET as
   `targetKeys[]`.
4. **Sending a turn.** When the user sends, the turn bubble shows the target
   chips in compact form (semi-transparent accent chips, plus a "Targeting
   n items" label). On the canvas (left), the target node(s) are highlighted
   with the active ring + glow + "Target" pill — the chat ↔ canvas link is
   explicit. The targets tray stays populated across turns until the user
   removes them.
5. **Pre-scoped entrance (MOTIR-1489).** When the Plan/Re-plan entrance opens
   the workspace from a specific item, that item is pre-filled as the initial
   target in the tray; the canvas highlights it; the AI's opening turn
   acknowledges the scope. The user CAN remove it (⨉) and/or add more — the
   entrance sets the _initial_ target, not a locked one.

### Primitives composed (no hand-rolling)

| Element                        | Built from                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| chat rail + bubbles + composer | the shipped `DiscoveryChatRail` language — `Card`/`Avatar`/`Input`/`Button`                                         |
| @-search dropdown              | the shipped `.pop`/`.pop-row` vocabulary from `internal-links.mock.html` panel 3 + the `mention-search` API fetcher |
| target chip in tray            | the shipped `WorkItemRefChip` component (`internal-links.mock.html` panels 0–2)                                     |
| ⨉ remove button                | `Button` (icon-only, `--radius-control`, ghost) with a `X` lucide icon                                              |
| map highlight                  | the shipped `.node.active` accent ring + glow from `planning-workspace.mock.html`                                   |
| @-trigger button               | `Button` (mono `@` glyph, `--radius-control`, soft fill) in the input's left padding                                |
| icons                          | lucide-react (`Search`, `X`, `BookOpen`, `CheckSquare`, `Bug`, `GitPullRequest`, `Target`)                          |

### Token / a11y discipline

- **Colour** strictly via `--el-*` (the mock inlines the real light-palette
  values). The dropdown popup reuses `--el-surface` / `--el-border` /
  `--el-muted`; the type icons are `--el-type-*`; the status Pill puts the
  hue in the tint background with `--el-text-strong` (finding #35, AA). The
  map highlight uses the accent ring (`--el-accent`) + glow (`--el-highlight`).
  ~~The @-trigger button is `--el-muted` text on `--el-surface-soft`.~~
  **⚠️ AMENDED (MOTIR-4346): the @-trigger button is `--el-text-secondary` on
  `--el-surface-soft`.** `--el-muted` is a FILL token (`#f3f4f6`), not an ink, so
  that sentence named a colour the element could not have been painted in; what
  the mock actually carried was the private `--muted` alias (`#787671`, the value
  of `--el-text-muted`), which is 4.34:1 on `--el-surface-soft` and fails AA.

> **⚠️ AMENDED 2026-09-03 (MOTIR-4346) — "strictly via `--el-*`" was FALSE of the
> asset until this date, and the sentence is what made it invisible.** The mock
> DID inline the real light-palette values, exactly as the clause says — onto 45
> PRIVATE names on its own `:root` (`--muted: #787671`, `--soft: #fafaf9`,
> `--surface: #ffffff`, …), and then painted through those. The values were right
> and a reader checking this claim against the file would have agreed with it.
> What a private name cannot do is flip with `data-palette`, follow a re-skin, or
> be MEASURED: `design-ink-contrast` and `design-state-ink-contrast` classify an
> ink by reading an `--el-*` name off the DECLARATION at the point of use, so
> `color: var(--muted)` was unmeasured however `--muted` was defined, and both
> guards were green about an asset neither had ever ruled on.
>
> **Rewriting every site at the point of use put the asset inside the guards, and
> the RESTING arm immediately reported 42 findings on it.** Each is amended here
> rather than left to be inferred from a diff:
>
> | element                                                                                                                                                               | was                                                       | is                                                                                                                                                                                               |
> | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | the dropdown row's monospace key (`.dr-key`)                                                                                                                          | `--el-text-muted` on `--el-surface-soft` (4.34:1)         | `--el-text-identifier` — the token that names the job (`theme.css`: _monospace MOTIR-123 keys_). This mock is older than that token, so it had to DECLARE it as well as consume it               |
> | the panel captions (`.cap`), the dropdown heading (`.drop-head`), the targets-tray label, the mini-panel labels, the canvas label, the state-card and mini-drop heads | `--el-text-faint` / `--el-text-muted`                     | `--el-text-secondary` — 6.18–6.80:1 on all four surfaces in both themes                                                                                                                          |
> | the composer placeholder (`Message Motir AI…`)                                                                                                                        | `--el-text-faint` (2.37–2.61:1 — clears AA on NO surface) | `--el-text-secondary`. A placeholder is active informational text, not decoration; the `::placeholder` RULE keeps `--el-text-faint`, because a pseudo-element is not what the board renders here |
> | the accent wash on the selected row, the `@` trigger and the target chips                                                                                             | `--accent-soft: #f4f2fd`                                  | `--el-accent-wash` = `color-mix(in srgb, var(--el-accent) 6%, var(--el-page-bg))` — the same derivation `plan-detail-list-view.mock.html` uses (MOTIR-4277)                                      |
> | the work-type hues (`--type-epic/story/task/bug/subtask`)                                                                                                             | five private names, incl. `#2a9d99`                       | `--el-type-{epic,story,task,bug,subtask}` — all five have token twins in `theme.css`, `#2a9d99` being `--el-type-subtask` (`--color-accent-teal`)                                                |
> | the brand gradient, the focus ring, the node glow, the white ink on the accent bubble                                                                                 | raw hexes and `rgba(255,255,255,…)`                       | `--el-accent` / `--el-highlight` / `--el-accent-text`, alpha expressed as `color-mix(… , transparent)`                                                                                           |
> | the spinner track                                                                                                                                                     | `#d8d4cd`                                                 | `--el-border-strong`                                                                                                                                                                             |
>
> Twelve aliases were DEAD — zero uses anywhere in the file — and are DELETED
> rather than translated: ten colour (`--hair-strong`, `--accent-text`,
> `--highlight`, `--success`, `--warning`, `--danger`, `--info`, `--rose`,
> `--yellow`, `--focus`) and two shape (`--r-modal`, `--sh-modal`). The drawn
> layout, copy, elements and access paths are UNCHANGED.

- **Shape** strictly via element-semantic tokens — the dropdown =
  `--radius-card`, rows = `--radius-control`, the @ button = `--radius-control`,
  chips = `--radius-control`, the send button = `--radius-btn`,
  shadow = `--shadow-elevated`. `rounded-full` only on the rail's status dot.
- **Not colour alone** — the `@` trigger pairs a glyph + "type to search" hint;
  the active dropdown row pairs highlight + `aria-selected`; each target chip
  pairs the type icon + key (not just a hue); the map "Target" pill pairs a
  label + the ring.
- **A11y** — the dropdown is a `role="listbox"` with `aria-label` and
  `aria-activedescendant`; the @ button is a real `Button` with a label; the
  ⨉ remove button has `aria-label="Remove <key>"`; the targets tray is a
  labelled group; decorative icons are `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface:
`design-notes.md` (this section) · `target-picker.mock.html` (source) ·
`target-picker.png` (full-page export, Playwright chromium — light,
~~`deviceScaleFactor: 2`, 1200px wide~~ **⚠️ AMENDED (MOTIR-4346): a 1200px
viewport at `deviceScaleFactor: 1`** — the committed export is 1200px WIDE, which
at 2× would mean a 600px viewport, and rendering it there reflows the board to
~2.8× its height. `scripts/render-design-mock.mjs`'s width search picks that
wrong pair unaided, so re-export this asset as
`--width 1200`); `prettier --check` clean. Grounded in
MOTIR-909 (session API) + MOTIR-1489 (entrance) + MOTIR-1399 (work-item-link
chip, shipped); gates MOTIR-1491 (code implementation).

---

## ⭐ Changing a plan is a CONVERSATION — the plan-change mode + the retired "Augment from prompt" door (MOTIR-1727, 2026-07-27)

**What changed, and why.** Product decision (Yue, 2026-07-27): **a change to the
plan is ALWAYS a conversation** — a single prompt is not enough to reshape a
plan. The shipped one-shot **"Augment from prompt"** entry (`MOTIR-903`, done) is
therefore retired: a `Button` in the `/backlog` + `/items` toolbars opening a
`Modal` with ONE `Input`, POSTing `{ prompt }` and rendering the delta in a fixed
bottom-right `PlanEditsReviewDock` — **with no way to refine**. If the result is
wrong you re-run a different prompt. That is a vending machine, not a planning
conversation, and it is a **second, bespoke AI surface** beside the universal
workspace (breaking the "all AI conversation rides ONE surface" invariant).
Story **MOTIR-1726** replaces it with the conversational surface and removes the
button.

**This amendment adds a STATE, it does not redraw the workspace.** The
`planning-workspace.mock.html` section above already specifies the four MODES as
states of the one surface, "each tied to its entrance door" — its **sheet 3**
names _"Augment / re-plan — 7.11 · Door: a project surface with a plan"_. That
mode was named but never drawn. This asset draws it, and sheet 3's mode card now
points here. **Nothing structural is new**: the two-pane frame, the canvas node +
edge language, the chat rail, the confirm-to-persist bar and the close-with-pending
guard are all composed verbatim from that asset.

**Grounded in the workflow-defining subtasks** (the design-content dependency
rule — design TO the spec, never invent the flow): **MOTIR-1729** (the workspace
HOST for an established project — mode + originating context, replacing the
launcher's dead-end round-trip), **MOTIR-1730** (the conversational rail — turn
list, composer, streamed delta, in-canvas diff, approve/discard, and the rail
STAYS OPEN after either), **MOTIR-1728** (the persisted, project-scoped session
whose ACCUMULATED turns drive the already-shipped `POST /api/ai/augment` job
contract — no engine change), and **MOTIR-1731** (the removal + its i18n and E2E
sweep).

**Asset:** `plan-change-conversation.mock.html` (source) +
`plan-change-conversation.png` (full-page export). A seven-panel review board:

| Panel | What it shows                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **The door** — the shipped `/backlog` chrome with the hero pill in `TopNav`, the floating **M** orb, ⌘K, and the `/roadmap` empty-state CTA; the augment button marked for retirement                           |
| **2** | **Opening it** on an ESTABLISHED project — the overlay over the (dimmed, inert) backlog, canvas seeded with the project's EXISTING tree, mode chip `plan change`, the **empty** conversation with starter chips |
| **3** | **The conversation** — turn 1 → proposal → turn 2 REFINES it → the **streaming** reply (caret + `Spinner`), canvas updating incrementally                                                                       |
| **4** | **Review** — the proposed changes as a **DIFF ON THE CANVAS** (add / change / remove) with `done` work **LOCKED**, the confirm-to-persist bar, and the corner `PlanEditsReviewDock` shown as **was → now**      |
| **5** | **The removed door** — `/backlog` and `/items` toolbars **today vs after**, drawn to scale, plus what deliberately STAYS                                                                                        |
| **6** | **Rail states** — empty · streaming · review · error · out of credits · after approve                                                                                                                           |
| **7** | **What it composes** — every element mapped to the shipped component or design that owns it                                                                                                                     |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn

Per design-against-shipped-reality (and lesson #73 — a surface reasoned from
`.tsx` alone silently drifts), every app strip on this board was **rendered from
the running app first** (production build, signed in, a PayFlow project, with
`MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` set so the launcher mounts). What the
render corrected:

- **The `TopNav` right cluster order** is `[Plan with AI] [Build in public]
[+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]` — the hero pill
  **leads** the cluster.
- **The two toolbars put the augment button in DIFFERENT places.** `/backlog`:
  `[View all work items] [Filter] [Advanced] [Saved ▾] [+ New work item]
[Augment from prompt]` — it **trails**. `/items`: `[Archived] [Filter]
[Advanced] [Saved ▾] [Tree ▾] [Augment from prompt] [+ New work item]` — it sits
  **between** the view switcher and New work item. Panel 5 draws both.
- **The vocabulary is "work item", not "issue"** — the real labels are
  _New work item_, _View all work items_, _Work Items_.
- **The launcher is gated**: `(authed)/layout.tsx:153` mounts the pill AND the FAB
  only when `isMotirAiConfigured() && activeProject`. With AI unconfigured the
  header has no pill at all — worth knowing before assuming the door is present.

### ⚠️ The door is GLOBAL — which is why the removal costs no access

The entrance was already corrected to be **global, not per-surface** (sheet 4,
2026-06-24): the header pill + ⌘K + the floating orb are on **every** PM screen,
so "Plan with AI" is summonable from `/backlog`, `/items` and `/roadmap` without
any of them owning a button. **"Augment from prompt" is the leftover of the older
per-surface model.** Retiring it removes a duplicate door, not a capability.

**But the door currently dead-ends on an established project** (verified, rung 2):
`planningWorkspaceHref()` returns `/onboarding?mode=…&from=…`, **no file reads
`?mode=`**, and `app/(onboarding)/onboarding/page.tsx` redirects an
onboarding-ran project to `/roadmap` — so the pill round-trips. MOTIR-1729 owns
the host that makes panel 2 real; this design does not assume it exists today.

### The conversation — multi-turn is the whole point (panel 3)

- **Turn 2 REFINES turn 1; it does not re-run it.** Each turn appends to a
  persisted, project-scoped session and the **ACCUMULATED** intent is submitted
  (MOTIR-1728), so "split it into monthly and yearly" lands on the proposal
  already on the canvas. The session is persisted, so **re-opening the workspace
  resumes the same thread**.
- **Streaming** uses the shipped `DiscoveryChatRail` language unchanged: partial
  text in an `aria-live="polite"` region with a caret, then the `Spinner` row
  while the delta is computed. The canvas places each proposed item as it arrives.
- **Empty is never a blank screen** — the canvas already shows the plan; only the
  conversation is empty. Three **starter chips** (outcome-phrased: _add work to an
  epic_ / _re-sequence what's left_ / _drop something we don't need_) prefill the
  composer. They are hints, not a mode menu.

### ⚠️ The review surface is the CANVAS, not a corner dock (panel 4)

The delta renders **on the canvas, on the node it affects** — this replaces
`PlanEditsReviewDock` **for this flow**. Four node states, each pairing a border
treatment + a glyph + a word (never colour alone):

| State      | Treatment                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------ |
| **add**    | dashed `--el-accent` border + faint accent-tinted surface + `＋ add` corner tag + `added` pill   |
| **change** | solid `--el-info` border + `--el-tint-sky` wash + `✎ change` tag + `changed` pill + what changed |
| **remove** | dashed `--el-danger` border + `--el-tint-rose` wash + struck-through title + `− remove` tag      |
| **locked** | **hatched** surface + 🔒 lock glyph + `✓ done` + `can't change` pills + `locked` tag             |

- **`done` work is LOCKED and the lock is legible.** The completion-aware
  guarantee (7.11) becomes visible: the engine proposes AROUND finished work,
  never over it, and the AI says so in the rail. An attempted immutable edit is
  rejected server-side.
- **Confirm-to-persist.** Nothing reaches the DB until **Approve changes**;
  **Discard** writes nothing. **After either, the conversation stays open** — that
  is what makes it a conversation rather than a transaction. Dismissing with a
  pending proposal raises the shipped close-with-pending guard (sheet 6).
- **Page state after approve:** the canvas is a **client island that owns its own
  state**, so it will NOT see `router.refresh()` — it needs an explicit refetch
  trigger; the server-rendered counts behind the overlay take the refresh. Both,
  where both apply (`motir-core/CLAUDE.md`).
- Edges keep the canvas's own language: firm neutral parent→child, **dashed
  accent** for proposed edges, dashed `--el-danger` into a removed node.

### ⚠️ The REMOVED door is drawn too (panel 5) — the removal corollary

Per `notes.html` **#154**, a decision that **removes** an affordance must spawn
its matching design amendment in the same pass, or the design of record keeps
depicting a control the product no longer has. Panel 5 is that amendment: the
`/backlog` and `/items` toolbars are drawn **today vs after**, to scale, one above
the other. **Nothing else shifts** — the toolbars are a plain flex row, so the
neighbour simply becomes the last control.

**What is lost:** one control on two surfaces, its `Modal` (a single `Input` +
Submit), and the three `planEdits.augmentPrompt*` keys in **both** locales.
**What deliberately stays:** the item-scoped `expand` / `replan` row actions
(`PlanEditsTrigger`) and their dock, the `/ready` expansion nudge, and
`POST /api/ai/augment` with its whole job path — the conversation drives that
same endpoint. Converging the row actions onto this workspace rides the per-item
entrance (MOTIR-812), not this story.

### States (panel 6)

**Empty** (opener + starter chips; the canvas still shows the plan) ·
**streaming** (partial text + `Spinner`, Send disabled until the turn settles) ·
**review** (rail mirrors the canvas bar's counts) · **error** (`role="alert"`,
**recoverable in place** — the thread and any prior proposal survive a retry) ·
**out of credits** (distinct from an error: nothing failed, the capability is
cloud-gated; the canvas stays readable) · **after approve** (the thread
continues — a plan change is rarely one change).

### Primitives composed (no hand-rolling)

| Element                                           | Built from                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the two-pane workspace frame                      | the shipped `components/planning/PlanningWorkspace.tsx` (`grid grid-cols-1 md:grid-cols-[1fr_22rem]`)                                                       |
| the header hero pill + the floating orb           | the shipped `PlanWithAILauncher` + `PlanWithAIFab`, mounted by `(authed)/layout.tsx` — never a hand-rolled AI affordance                                    |
| canvas, nodes, edges, zoom, search, crumb         | the standalone work-item canvas — design `design/roadmap/` (MOTIR-1009) over `ProjectRoadmapCanvas` / `PlanningCanvas`; composed, never redrawn             |
| the diff rendering                                | `components/planning/PlanReviewCanvas.tsx` (already feeds proposed items into the canvas as data); this asset adds only the change / remove / locked states |
| the chat rail (head, bubbles, drafting, composer) | the shipped `DiscoveryChatRail` language — `Card`/`Avatar`/`Input`/`Spinner`/`Button`; the only per-mode difference is the mode chip                        |
| confirm-to-persist bar + pending guard            | `planning-workspace.mock.html` sheets 2 + 6, unchanged — only the copy names add/change/remove/locked counts                                                |
| the @-mention target picker in the composer       | already designed — `target-picker.mock.html` (MOTIR-1490); composes in unchanged, not redrawn here                                                          |
| the multi-turn session behind it                  | MOTIR-1728 — accumulated turns → the shipped `POST /api/ai/augment` contract; no new job kind                                                               |
| icons                                             | lucide-react (`Sparkles`, `Lock`, `Plus`, `Pencil`, `Minus`)                                                                                                |

### Token / a11y discipline

- **Colour** strictly via `--el-*`, declared under the tokens' **own names** and
  painted through them at every site. Every non-token fill is a `color-mix()` of
  two tokens — **no invented hue**. Tinted chips put the hue in the
  **background** with `--el-text-strong` (finding #35, AA). Work-item type hues
  are `--el-type-*`; the hero pill's gradient + glow are palette-derived
  (`--el-accent` → `--el-highlight`) with the label over the accent-dominant
  region.

### ⚠️ AMENDED 2026-09-03 (MOTIR-4347, under MOTIR-4318) — the colour rule above was FALSE

The bullet above used to read: **strictly via `--el-*` (the real light values
inlined at the top of the mock, as the sibling `design/ai-chat/` mocks do)**.
The values were inlined. The NAMES were not.

`plan-change-conversation.mock.html` declared a `:root` block of
**privately-named aliases** — `--text`, `--muted`, `--surface`, `--hub`,
`--mutedfill`, and 27 more — each annotated with the token it stood for, like
`--muted: #787671;` followed by a comment naming `--el-text-muted`. It painted
through those aliases at all **292** `var()` sites and declared **no**
`--el-*` custom property at all.

The rendered pixels were right, which is why the pattern survived review, and
the comments made it read as deliberate. What it could not do is flip with
`data-palette`, follow a re-skin, or be **measured**: both ink guards
(`tests/theme/inkContrastMockScan.ts` and `tests/theme/mockStateInkScan.ts`)
classify ink by reading a token name off the declaration **at the paint site**,
so every site in this asset sat outside them by construction and their
tree-wide greens said nothing about it. **A comment naming a token is not a
token** — the aliases and their annotations are both deleted.

**Superseded with them:** the old clause **the only raw values are the body
backdrop and the canvas grid-dot texture**. Both are now all-token
`color-mix()`es:

| was                                             | is                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `#f1efec` — the body backdrop the sheets sit on | `color-mix(in srgb, var(--el-surface) 50%, var(--el-canvas))`       |
| `#e0ded8` — the canvas grid-dot texture         | `color-mix(in srgb, var(--el-border) 83%, var(--el-border-strong))` |

The raw values that remain are the ten **box shadows** (alpha-black,
`#0000000d` through `#00000026`). A shadow is not a hue; the design system
keeps its own shadows as raw alpha (`--shadow-subtle`), and mixing one from an
ink token would invert it under a dark palette.

#### The AA findings the swap EXPOSED — 73, in an asset that had never been measured

Declaring the ink under its real name made this asset legible to the guards for
the first time. The resting arm immediately reported **73 findings across 66
lines** — 47 on `--el-text-faint`, 26 on `--el-text-muted` — every one of them
carried unseen since the asset was drawn. The state arm reported none.

`--el-text-faint` is 2.37–2.61:1 and clears AA on **no** surface, so it may
carry decoration and disabled text only. It was painting eight rules' worth of
active informational text. `--el-text-muted` is 4.12–4.34:1 on
`--el-surface-soft` and clears AA only on the white page/card.

| rule                                                                                                                                      | was               | is                    | why                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.chip.ico`, `.tbtn .g`, `.searchbox kbd`, `.crumb .muted`, `.composer .inp`, the two inline `<kbd>` hints, the dock's inline close glyph | `--el-text-faint` | `--el-text-muted`     | all sit on `--el-page-bg`, where muted clears AA — so the drawn hierarchy (glyph quieter than its label) is kept                                                  |
| `.page-head p`, `.sheethead .cap`, `.legend`, `.nsub`, `.drafting`, `.statecard .sh .k`, `.emptyhint`, the three inline locked-node tiles | `--el-text-muted` | `--el-text-secondary` | each sits on `--el-surface-soft`, on the `--el-muted` tile fill, or on the sheet backdrop, where muted is under AA; secondary is 6.18–6.80:1 on all four surfaces |

Both arms are now **0** findings tree-wide, and for the first time that
sentence includes this file.

- **Shape** strictly via element-semantic tokens — node = `--radius-card`, pills =
  `--radius-badge`, buttons = `--radius-btn`, the composer input =
  `--radius-input`, toolbar controls + rail rows = `--radius-control`, elevation =
  `--shadow-{subtle,card,elevated}` — so a `[data-style]` swap reshapes the surface.
  `rounded-full` only on the status dot, avatars and the orb.
- **Not colour alone** — every diff state pairs a border treatment + a glyph
  (＋ ✎ − 🔒) + a word; every rail state pairs its icon with a sentence.
- **A11y** — the canvas and the rail are labelled regions; the streaming reply is
  `aria-live="polite"`, the error is `role="alert"`; a node's diff state is in its
  accessible name ("Recurring invoices, proposed addition"), not its border alone;
  a locked node is `aria-disabled` and says why; Approve / Discard are real buttons
  in the tab order; `Esc` closes through the pending guard.

### Deliverable

The three-file set under `design/ai-chat/` for this surface:
`design-notes.md` (this section) · `plan-change-conversation.mock.html` (source) ·
`plan-change-conversation.png` (full-page export, Playwright chromium — light,
`deviceScaleFactor: 2`, 1200px wide); `prettier --check` clean. Composes
`planning-workspace.mock.html` (MOTIR-1193) + `design/roadmap/` (MOTIR-1009);
grounded in MOTIR-1728 / 1729 / 1730 / 1731; gates those four code subtasks.

---

## ⭐ The Motir callout — the orb becomes a TRIGGER (MOTIR-1811, 2026-08-01)

**What changes.** The shipped floating **"M"** orb (`PlanWithAIFab`, MOTIR-1299)
navigates **straight** to the planning workspace today. It becomes the **trigger
for a small anchored menu** — "the home of all AI" — whose first action is
_Plan with AI_, with _Ask about this project_ (MOTIR-1343) and _Help with a task_
(MOTIR-1344) mounting into the same menu as their stories land. **The orb is the
ONLY entrance this touches** — the TopNav hero pill, ⌘K, the work-item door
(MOTIR-910) and the roadmap door (MOTIR-1011) are all unchanged.

### ⭐ EVERY ROW OPENS THE SAME SURFACE — the menu only says what the callout CAN DO (Yue, 2026-08-01)

> **UNCHANGED by the 2026-08-19 glyph amendment (MOTIR-3183).** That pass renamed the surface in
> prose — _the Motir callout_, whose trigger is _the Motir orb_ — and swapped the letter inside the
> circle for the mark. **It touched no mechanism**: one href shared by every row, a row is a LABEL
> and not a route, a row appears when its capability lands, and a row may seed the composer's
> starter phrasing without constraining the thread. The name changed because it had stopped
> describing the thing; the contract below did not.

Motir has exactly one AI conversation surface — the `PlanningWorkspace` hosted at
`/planning` (MOTIR-1729) — and **all three rows navigate to that one surface with
the same context-derived href**, via the shipped `planningWorkspaceHref()`. The
callout is **not a mode picker and not a router**: it is a **capability list**, an
answer to "what can I ask this thing?", and the row the user picks does **not**
narrow what the conversation can be about.

**Why.** The conversation is free-form and **the user can switch topic
mid-conversation** — plan the sprint, then ask what blocks a card, then get help
drafting its description, all in one thread. A mode chosen at the door would be
wrong within one turn, and enforcing it would fragment the one surface the product
deliberately has. So the door does not choose; it only **advertises**. The topic is
chosen — and re-chosen — inside the conversation.

Three consequences the code subtask must honour:

- **One href, shared by every row.** Not three destinations, not three modes, not a
  thread locked to one kind of question. A row is a **label**, not a route.
- **A row appears when the CAPABILITY exists behind that one surface** (MOTIR-1343
  / MOTIR-1344) — what a story adds is what the workspace can do, never where the
  row points.
- **A row may seed the composer's starter phrasing**, but it never constrains the
  thread. The composer slot is the same door with the first turn already typed.

Still forbidden in the other direction: a row that opens a **bespoke per-feature
chat panel**. Every row is a door to the ONE workspace.

**It DEEPENS the sketch, it does not re-invent it.** `planning-workspace.mock.html`
sheet 4 ("B — Floating 'M': the universal AI callout") already draws the callout
at options-comparison depth — the "Motir AI" header, three icon + title +
description rows, an "Ask Motir anything…" field. That visual language is settled
and reproduced here; what this asset adds is BUILD depth. The orb's own fill, glow
and pulse, and the planning workspace itself (7.20.1 / MOTIR-1193), are composed,
never redrawn.

**Asset:** `ai-callout-menu.mock.html` (source) + `ai-callout-menu.png` (full-page
export). An eight-panel review board:

| Panel | What it shows                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **The access path** — the orb in situ over the shipped authed shell, closed (today: click → `/planning`) then open                    |
| **2** | **The orb's trigger role** — `<Link>` → `Popover.Trigger` + `<button>`, the accessible-name change, and its four states               |
| **3** | **Both menu states** — interim (header + the one live row) · target (three rows + composer) · and the FORBIDDEN "coming soon" variant |
| **4** | **Row anatomy** — icon tile, title, one-line description, and rest / hover / focus-visible / active                                   |
| **5** | **Open · close · keyboard** — the shipped `UserMenu` popover idiom, plus the anchoring + panel props                                  |
| **6** | **Narrow / mobile** — 390 px and 320 px drawn TO SCALE, the width clamp, and the never-covers-the-orb rule                            |
| **7** | **Dark, AA, and surface material** — the real dark token flip, the per-element ink table, `data-surface="popover"`                    |
| **8** | **What it composes** — every element mapped to its shipped owner — and which entrances stay exactly as they are                       |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn

Per design-against-shipped-reality (lesson #73), both surfaces this design
composes were **rendered from the running app first** (production build, signed
in, an active project, `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` set so the
launcher mounts) and the mock reuses that markup rather than a stylised
stand-in. What the render pinned down:

- **The orb** is an `<a href="/planning?mode=project&from=project">` with
  `aria-label="Plan with AI"` — 56 × 56 (`h-14 w-14`), `fixed right-5 bottom-5
z-40`, `rounded-full`, the radial accent fill + pink aura + the 3.2 s
  `.plan-with-ai-fab-pulse` ring. Measured at **x 1364, y 824** on a 1440 × 900
  viewport and **x 314, y 704** at 390 × 780 — the same 20 px offsets, no
  breakpoint.
- **`Popover.Content` renders `role="dialog"`**, not `role="menu"` — with
  `data-side` / `data-align` / `data-state` on the panel and the shipped
  `UserMenu` holding plain links inside it. That is the keyboard contract this
  design mirrors, and it is why a roving `menuitem` model is explicitly ruled out.
- **The shipped `UserMenu` panel** is 240 px, `--radius-card` (12 px),
  `--el-page-bg`, a `--el-border` hairline, `--shadow-elevated`, `py-1`, a
  bordered header block (`px-3 pb-2 pt-2`) and rows with a 16 px muted lucide
  glyph + a 14 px `--el-text` label.
- **The `TopNav` right cluster** is `[Plan with AI] [Build in public]
[+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]` — the hero pill leads
  it, and it is present on every authed screen, which is why losing the orb's
  direct navigation costs no access.
- **A shape drift worth fixing while mirroring:** the shipped `UserMenu` rows
  render `rounded-(--radius-sm)` with raw `px-2 py-2` — Tier-0 shape a
  `data-style` swap cannot reshape. The callout's rows take the element-semantic
  tokens (`--radius-control`, `--spacing-control-x/y`) instead; rendered values
  are near-identical today, so nothing looks different.

### ⚠️ The interim menu is deliberate — and the fast lane is NOT lost

The menu ships with **one** row, because one capability exists. That is a real cost
(an extra click on the orb) and it is paid on purpose: the header names the
surface so the single row reads as "the first of several", and the architecture
that holds all three actions is built once rather than retrofitted. **The direct
one-click path survives untouched** — the TopNav hero pill and ⌘K still go
STRAIGHT to `/planning` on every screen (panel 8). And `⌘`/middle-click is
preserved one level in, because every row is a real link.

**An action whose story has not landed is ABSENT — never a dimmed, disabled or
"Coming soon" row** (drawn as the forbidden variant in panel 3). A dead row is a
promise the product cannot keep, it costs a tab stop and a screen-reader
announcement, and it makes the interim state feel broken rather than young.

### The panel — anchoring, and the keyboard model it inherits

| Prop               | Value   | Why                                                                |
| ------------------ | ------- | ------------------------------------------------------------------ |
| `side`             | `top`   | the orb hugs the bottom edge — there is no room below              |
| `align`            | `end`   | right edges line up with the orb, away from the viewport edge      |
| `sideOffset`       | `12`    | clears the orb's outer glow (the primitive's default 8 sits in it) |
| `collisionPadding` | `16`    | keeps the panel off every viewport edge when it shifts             |
| `width`            | `288`   | fits the longest description on ONE line; 320 is wider than needed |
| `overflowVisible`  | `false` | static rows only — the default clip is correct                     |
| `modal`            | `false` | the page behind stays scrollable + readable, like the user menu    |

**Keyboard = the shipped `UserMenu` idiom, unchanged.** Open with click / `Enter`
/ `Space`; `Tab` and `Shift+Tab` walk the rows in DOM order (composer last, once
it exists); `Enter` follows the row's `href`; `Esc` or a click outside dismisses;
focus returns to the orb on every close path (Radix's `onCloseAutoFocus`).
**Do NOT invent a roving `role="menu"` pattern** — a second, contradictory model
would make two shell menus behave differently under the same-looking chrome. If a
future card genuinely wants arrow-key roving it must say so explicitly and specify
the FULL `menu` / `menuitem` semantics (`aria-activedescendant` or roving
`tabindex`, typeahead, Home/End); it is not something to half-build.

**Motion.** While the menu is open the pulse **stops**
(`[data-state='open'] .plan-with-ai-fab-pulse { animation: none }`, keyed off the
attribute Radix already sets on the trigger) so the panel never sits inside a
breathing halo — stopping, not `animation-play-state: paused`, which would freeze
the ring at an arbitrary radius. The pulse is already gated behind
`@media (prefers-reduced-motion: no-preference)`, so a motion-sensitive user never
sees it in any state and the open-state rule is a no-op for them.

**Responsive.** `width: min(288px, calc(100vw - 2rem))`; the rows reflow (the
description wraps) rather than truncating. `side="top"` + `sideOffset: 12` put the
panel's bottom edge 12 px above the orb's top, so it can never cover the trigger —
there is never room below for Radix to flip into. At 320 px the collision padding
shifts the panel 4 px, leaving 16 px margins. The orb itself gets no new
responsive rule.

### Primitives composed (no hand-rolling)

| Element             | Built from                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the orb             | the shipped `components/planning/PlanWithAIFab.tsx` — fill, aura, pulse, position, size verbatim; only the ELEMENT changes                                               |
| the panel           | `Popover` / `Popover.Trigger` / `Popover.Content` from `@motir/design-system` (re-exported at `components/ui/Popover.tsx`)                                               |
| header block + rows | the shipped `app/(authed)/_components/UserMenu.tsx` idiom — bordered header, `--el-surface` row hover, muted lucide glyph                                                |
| the destination     | `lib/planning/launcher.ts` — `planningWorkspaceHref()` / `PLANNING_WORKSPACE_PATH`; **ONE href shared by every row** — no new route, no new mode, no per-row destination |
| the composer slot   | `Input` shape tokens (`--radius-input`, `--height-control`); its behaviour is MOTIR-1343's to specify — this asset reserves the slot                                     |
| icons               | lucide-react — `Sparkles`, `MessageCircleQuestion`, `Wrench`, `ArrowUp`                                                                                                  |
| gating              | unchanged — `(authed)/layout.tsx` mounts the orb only under `isMotirAiConfigured() && activeProject`                                                                     |

### Token / a11y discipline

- **Colour** strictly via `--el-*`. The mock's token block is **generated
  verbatim** from `packages/design-system/theme.css` (the Tier-0 `@theme` +
  `[data-theme='dark']` blocks and the Tier-3 `:root,[data-appearance-scope]`
  layer), and every icon is a real lucide `__iconNode` path — so the asset cannot
  drift from the shipped design system and contains **no retyped hex and no
  invented hue**. The header tint and the icon tiles are `color-mix()` of
  `--el-accent` → `--el-highlight` over `--el-page-bg` — the same palette-derived
  recipe the shipped hero pill and orb already use.
- **Shape** strictly via element-semantic tokens — panel = `--radius-card`, rows +
  icon tiles = `--radius-control`, composer = `--radius-input`, chips =
  `--radius-badge`, elevation = `--shadow-elevated`, row padding =
  `--spacing-control-x/y`. `rounded-full` only on the orb and the avatar.
- **Dark** is drawn from the real dark token flip (`data-theme="dark"` **plus**
  `data-appearance-scope`, since the Tier-3 layer is declared on
  `:root,[data-appearance-scope]` and a nested subtree must re-emit it).
- **AA** — the row description is `--el-text-secondary`, never `--el-text-muted`,
  which fails at 11.5 px; tile ink is `--el-accent-text` on the accent-dominant
  gradient and `--el-accent-on-surface` on the tint.
- **Not colour alone** — the primary row is marked by its filled tile AND its
  position; every state pairs a fill with a ring.
- **A11y** — the trigger's accessible name becomes **"Motir AI"** ("Plan with AI"
  moves inside, as the row's name) and Radix adds `aria-haspopup="dialog"` /
  `aria-expanded` / `aria-controls`; rows are real links in the natural tab order;
  focus-visible draws the 2 px `--focus-ring-color` ring inset so it never clips
  at the panel edge.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `ai-callout-menu.mock.html` (source) · `ai-callout-menu.png`
(full-page export, Playwright chromium — light, `deviceScaleFactor: 2`, 1240 px
wide). Composes `planning-workspace.mock.html` sheet 4 (MOTIR-1193); gates the
code subtask **MOTIR-1812** (the callout menu shell), and reserves the rows
MOTIR-1343 / MOTIR-1344 deliver.

---

## ⭐ The planner SPEAKS in the plan-change thread — the findings report, the question, and the waiting rail (MOTIR-2225, 2026-08-05)

**Amendment to this asset set, for `MOTIR-2225`.** `MOTIR-2222` (motir-ai) gives the
planner a voice: **every** planning turn now returns a message — a findings
report before the proposals, and at most one clarifying question when the
request is genuinely not determinate. The plan-change thread has nowhere to put
either. This section draws that room. The code subtask it gates is
**`MOTIR-2226`** (the `assistant` turn role, its rendering, and the reply path),
which is `blocked_by` this design.

**Asset:** `plan-change-planner-speaks.mock.html` (source) +
`plan-change-planner-speaks.png` + `plan-change-planner-speaks.dark.png`. A
six-panel review board, every state drawn **in situ** — inside the real
two-pane workspace, at the rail's real `22rem`, beside the real canvas.

| Panel   | What it shows                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | **The access path, unchanged** — the shipped `TopNav` hero pill, the floating **M** orb and ⌘K on any authed screen, opening the one planning workspace this all happens inside |
| **A**   | **The findings report** — the planner's per-turn narration, with work-item chips, arriving **before** the proposals land on the canvas                                          |
| **B**   | **The question, and the whole rail waiting on it** — the asking bubble plus what changes around it, and the comparison table that carries the load-bearing decision             |
| **C**   | **The answer and the resumption** — and the same session reopened hours later, its pending state recovered from the persisted thread rather than from client state              |
| **D·E** | **Work-item chips at realistic density**, and **the question nobody answered** — superseded, marked, never dropped and never blocking                                           |
| **F**   | **Anatomy + the token map** the code card composes, in light and in the real dark flip                                                                                          |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn (`notes.html` #73)

Every rail fragment on the board is the **real emitted markup** of the shipped
`components/planning/PlanChangeRail.tsx` + `PlanChangeComposer.tsx`, captured by
a headless render of the actual components (the repo's own
`tests/helpers/renderWithIntl` harness → `container.innerHTML`) against the real
`packages/design-system/theme.css`, at the rail's real width. The class strings
in the mock are therefore not a stylised redraw — they are what the app emits,
so the asset cannot silently drift from the implementation and the code card can
lift the new elements' markup verbatim. What the render corrected, versus what
reading the `.tsx` alone would have suggested:

- **An assistant/user contrast already exists**, and it is strong: the assistant
  bubble is the soft `--el-chat-bubble-ai` fill with the accent **M** avatar on
  the LEFT; the user bubble is the accent fill with a `·` avatar and the whole
  row `flex-row-reverse`. A findings report needs **no new treatment at all** to
  read as the planner speaking.
- **The `label` slot already renders inside the bubble** (mono, 10 px, uppercase,
  `opacity-80`) and is used **only by user turns** today (`turn 1`,
  `turn 2 · refine`). That is why the question reuses that slot rather than
  inventing a bubble header.
- **The submission marker is a centred `--el-text-faint` line**, not a bubble —
  the vocabulary both new marker lines borrow.
- **At `22rem` the rail header is already full** (status dot + `Motir AI` +
  mode chip), which is why the pending state lives on the composer and not in a
  header pill.

### ⚠️ INHERITED vs NEW — what is not redrawn

**Inherited, verbatim** from `plan-change-conversation.mock.html` (MOTIR-1727)
and the shipped components it composes: the two-pane frame
(`PlanningWorkspace`, `grid-cols-[1fr_22rem]`), the canvas pane and its node +
edge language (`design/roadmap/`, MOTIR-1009, over `PlanningCanvas`), the rail
head, the assistant `Bubble` anatomy that **panel 3 of that asset already draws
as the AI reply**, the user bubble, the submission marker, the confirm-to-persist
review block, the `@`-target composer, and the exit chrome. **The bubble, the
rail, the composer and the canvas are NOT redrawn here.**

**Genuinely new — four things, and only four:**

1. An assistant turn that is **persisted** (it belongs to the thread's history and
   survives a reload, rather than being local chrome as every assistant bubble on
   screen today is).
2. The **asking** variant of that bubble — the same anatomy with two token values
   swapped and the existing label slot filled.
3. The **answer bar**, a sibling pinned above the composer input where the target
   tray already sits.
4. Two **marker lines** in the shipped marker vocabulary — _Answered — planning
   resumed_ and _Not answered — Motir AI carried on with what you asked_.

### ⭐ The load-bearing decision: a report and a question at a glance

Most turns are reports; questions are rare by construction, because `MOTIR-2222`'s
whole bar is _derive before you ask_. That ratio is exactly what makes a question
dangerous — a rare thing that looks like the common thing gets skimmed, and a
skimmed question is a thread that dies silently with each side waiting on the
other. So the distinction cannot rest on wording, and it does not rest on colour
either. In one sentence:

> **A report changes only the transcript. A question changes the composer.**

|             | report                      | question                   |
| ----------- | --------------------------- | -------------------------- |
| bubble fill | `--el-chat-bubble-ai`       | `--el-warning-surface`     |
| bubble ink  | `--el-text`                 | `--el-warning-text`        |
| label slot  | none                        | `asking` + the `?` glyph   |
| answer bar  | —                           | pinned above the composer  |
| placeholder | _Reply, or refine further…_ | _Answer Motir AI…_         |
| Send button | icon only                   | icon + the word **Answer** |
| canvas      | proposals land              | untouched                  |

**Three cues, none of them colour alone:** a word (`asking` / _Waiting for your
answer_ / **Answer**), a glyph (lucide `message-circle-question-mark`), and a
**position** — the bar sits against the input, which is pinned, so "the planner
is waiting on you" is legible with the thread scrolled anywhere.

**No dashed or dotted border carries the pending state.** Pending is a
token-driven tint plus a label: a hardcoded dashed edge would fight the
`data-style` axis and collide with the canvas's proposed-node language, which
already owns dashed-accent.

**Why a bar and not a header pill:** measured at the rail's real `22rem`, the
header row already carries the status dot, the `Motir AI` label and the mode
chip; a fourth element truncates. The bar has the full width, sits in the pinned
region, and is adjacent to the control whose behaviour actually changed.

### The states (A–E)

| State | What it is                                                                   | How it is drawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **The findings report** — what was searched, what came back, what that means | An **ordinary** assistant `Bubble`: same fill, ink, avatar and width as the opener and the proposal summary. It arrives **before** the proposals, so a wrong match is catchable before a branch is built on it (the ordering `MOTIR-2222` asserts on the producing side).                                                                                                                                                                                                                                                                                                                                              |
| **B** | **The question** — the request admits two outcomes the grounding cannot rank | The same `Bubble` with `--el-warning-surface` / `--el-warning-text` and the `asking` label + glyph, **plus** the answer bar, the `Answer Motir AI…` placeholder and the relabelled Send. The canvas stays untouched — nothing is proposed while the planner is blocked.                                                                                                                                                                                                                                                                                                                                                |
| **C** | **The answer, and resumption**                                               | An **ordinary user turn**, labelled `answer` in the slot user turns already number themselves in — not a paired or nested element. Resumption is one centred `--el-text-faint` marker, _Answered — planning resumed_. The bar clears, Send returns to its icon, the placeholder returns.                                                                                                                                                                                                                                                                                                                               |
| **D** | **Referenced work items inside a turn**                                      | The shipped `WorkItemRefChip` autolink, reused as-is (type-hue icon · mono key · title · status dot, peek on click) — no new inline treatment. **Two or three per report is the density**, and it is a decision: the chip is `white-space: nowrap`, so a fourth turns a report at `22rem` into a wall of boxes. A report with no match names none.                                                                                                                                                                                                                                                                     |
| **E** | **A question left unanswered**                                               | **SUPERSEDED — never dropped, never blocking.** The instant the user sends anything else the pending state clears (bar gone, Send an icon, placeholder back) and the planner proceeds on its own best reading of the original request. The question bubble **stays in the thread exactly as it was** — it is a persisted turn and the transcript never rewrites itself — and gains one marker line beneath it: _Not answered — Motir AI carried on with what you asked_. Not dimmed, not struck through, not removed: the user has to be able to see later **why** a plan rests on an assumption they never confirmed. |

**Awaiting is DERIVED, not stored client-side.** The rail is in the awaiting
state exactly when _the last planner turn is a question with no user turn after
it_. That is why panel C's second frame — the same session reopened hours later
from a cold start — comes back to the identical bar, placeholder and button, and
it is what `MOTIR-2226`'s reload criterion asserts.

### Primitives composed (no hand-rolling)

| Element                               | Built from                                                                                                           | Colour                                                     | Shape                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| the two-pane frame                    | the shipped `PlanningWorkspace` (`grid-cols-[1fr_22rem]`)                                                            | —                                                          | —                                                                        |
| canvas pane, nodes, edges             | the standalone work-item canvas (`design/roadmap/`, MOTIR-1009) over `PlanningCanvas` — composed, never redrawn      | `--el-canvas`, `--el-type-*`, `--el-canvas-edge-committed` | `--radius-card`                                                          |
| rail head, bubbles, markers, composer | the shipped `PlanChangeRail` / `PlanChangeComposer` — real emitted markup                                            | as shipped                                                 | as shipped                                                               |
| **report bubble**                     | `Bubble role="assistant"`, unchanged                                                                                 | `--el-chat-bubble-ai` / `--el-text`                        | `--radius-card`                                                          |
| **question bubble**                   | the same `Bubble`, `label` slot filled                                                                               | `--el-warning-surface` / `--el-warning-text`               | `--radius-card`                                                          |
| **asking label**                      | the `label` span user turns already use                                                                              | inherits the bubble ink at `opacity-80`                    | `font-mono text-[10px] uppercase`                                        |
| **answer bar**                        | NEW — a sibling in `PlanChangeComposer`, where the target tray sits                                                  | `--el-warning-surface` / `--el-warning-text`               | `--radius-card`; its button `--radius-control` + `--spacing-control-x/y` |
| **Send → Answer**                     | `Button variant="primary" size="sm"` with a visible label                                                            | `--el-accent` / `--el-accent-text`                         | `--radius-btn`, `--height-btn-sm`                                        |
| **resumed / not-answered markers**    | the shipped `system`-marker line                                                                                     | `--el-text-faint`                                          | `text-center text-xs`                                                    |
| work-item reference                   | the shipped `WorkItemRefChip` (`.wi-chip`)                                                                           | `--el-surface-soft`, key `--el-link`, hue `--el-type-*`    | `--radius-control`, `--spacing-kbd-x/y`                                  |
| the entrance (panel 1)                | the shipped `PlanWithAILauncher` + `PlanWithAIFab` + ⌘K — unchanged, drawn so the reader sees the door               | palette-derived hero gradient                              | `--radius-badge`                                                         |
| icons                                 | lucide-react — `message-circle-question-mark`, `send`, `at-sign`, `sparkles`, `check`, the `--el-type-*` kind glyphs | —                                                          | —                                                                        |

### Token / a11y discipline

- **Colour** strictly via `--el-*`. The mock's stylesheet is Tailwind's **real
  output for this page**, built over `packages/design-system/theme.css`, so the
  Tier-0 `--color-*`, the `[data-theme='dark']` flip and the Tier-3 `--el-*`
  layer are the shipped values verbatim — **no retyped hex and no invented hue**.
  Even the canvas grid-dot texture is a `color-mix()` of two tokens.
- **Shape** strictly via element-semantic tokens (`--radius-card|control|input|badge`,
  `--spacing-chip-x/y`, `--spacing-control-x/y`, `--spacing-kbd-x/y`,
  `--height-btn-sm`, `--shadow-*`), so a `data-style` swap reshapes the new bar
  exactly as it reshapes the bubbles. `rounded-full` only on the status dot, the
  avatars and the orb.
- **AA** — charcoal `--el-warning-text` on `--el-warning-surface` is the
  tint-background recipe finding #35 pins (~10:1 in both themes); the hue never
  lands under light ink. The `See it` control is a real button, not link-coloured
  text on a tint.
- **Not colour alone** — every new state pairs its tint with a word AND a glyph,
  and the awaiting state additionally changes a control's label and position.
- **Dark** is drawn from the real token flip (`data-theme="dark"` **plus**
  `data-appearance-scope`, since the Tier-3 layer is declared on
  `:root,[data-appearance-scope]` and a nested subtree must re-emit it). The
  states stay distinguishable — the warm `--el-warning-surface` against the
  near-black `--el-chat-bubble-ai` — which is why the `.dark.png` ships.
- **A11y** — the question is an ordinary turn inside the rail's existing
  `role="log"`; the answer bar is not an alert (nothing failed) but its copy
  names the state in text, so it is announced when the log updates; the composer's
  `aria-label` tracks its placeholder, as the shipped composer already
  guarantees; `See it` moves focus to the question turn; decorative glyphs are
  `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `plan-change-planner-speaks.mock.html` (source) ·
`plan-change-planner-speaks.png` (+ `.dark.png`), full-page Playwright chromium
exports, `deviceScaleFactor: 2`, 1240 px wide; `prettier --check` clean.
Composes `plan-change-conversation.mock.html` (MOTIR-1727) +
`planning-workspace.mock.html` (MOTIR-1193); grounded in the producer
**MOTIR-2222**; gates the code subtask **MOTIR-2226**.

---

## ⭐ Ask about this project — the cited ANSWER turn, and the chrome that follows the turn (MOTIR-1815, 2026-08-20)

**What changes.** A turn in the one conversation can now be a **question** rather
than a plan change. Nothing about the surface changes with it: the same
workspace, the same rail, the same composer, the same single door. What changes
is that a turn has an **intent**, that intent is resolved by the server and comes
back on the turn, and the canvas chrome follows the **latest turn**.

**Asset:** `ask-answers.mock.html` (source) + `ask-answers.png` (full-page
export). A nine-panel review board.

| Panel | What it shows                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------- |
| **1** | **The door** — the "Ask about this project" row, what it opens, and the one thing it seeds                     |
| **2** | **The cited ANSWER turn** — the new turn form, and why citations are inline                                    |
| **3** | **⭐ The chrome transition** — one footer slot, two contents, drawn at all three moments                       |
| **4** | **A mixed thread in both orders** — ask→change and change→ask, and how the two turn kinds read apart           |
| **5** | **The correction marker** — both labels, and what re-running a turn does to the transcript                     |
| **6** | **The redirect's second stream** — the hand-off state, so the rail never shows two spinners with a gap between |
| **7** | **Six states** — empty · thinking · answered · **no confident answer** · error · out-of-credits                |
| **8** | **Dark, and the ink every new element carries** — the real token flip and the per-element AA table             |
| **9** | **What it composes** — every element mapped to its shipped owner, and the four things this asset actually owns |

### ⚠️ SCOPE — four elements, and everything else is composed

The two-pane frame is `planning-workspace.mock.html` (MOTIR-1193); the rail
shell, its bubbles, its markers, its composer and the confirm bar are
`plan-change-conversation.mock.html` (MOTIR-1727) and
`plan-change-planner-speaks.mock.html` (MOTIR-2225); the canvas is
`design/roadmap/` (MOTIR-1009). **None of them is re-specified here.** This asset
owns exactly four things: the **answer turn's form** (panel 2), the **canvas
footer slot** (panel 3), the **correction marker + the redirect hand-off**
(panels 5–6), and the **ask row's copy, the fourth starter and the widened
opener** (panel 1).

**And it does NOT own the avatar's glyph.** The Motir mark inside the 28 px
assistant circle is the sibling glyph design's element (MOTIR-3183, § "The
identity glyph wherever Motir speaks"); its path lives in
`components/brand/waveBand.ts` and reaches every surface through
`BrandMark variant="mark"`. This asset draws that specimen at the 13 px it
specifies and re-decides nothing about it. **No stand-in letter appears anywhere
in the asset.**

### ⚠️ Two rungs above fix what this may draw — cited, never re-opened

- § **"EVERY ROW OPENS THE SAME SURFACE"** (above): every row shares ONE href, a
  row is a **label** and not a route, and a row may seed the composer's starter
  phrasing without constraining the thread.
- **`docs/decisions/conversation-turn-intent.md`** (MOTIR-1816): §1 intent is
  **server-resolved** and the client sends none; §2 `ask` is the one door and the
  resolver is the `ask_project` job's first step; §3 a mis-read is corrected by
  **re-running the same turn**; §4 the not-confident default is `ask`; §5 intent
  is per-**TURN** and a row seeds TEXT only.

So there is **no ask/act switch** in the composer, **no `?mode=ask`**, no second
href, no per-feature chat panel, and no session-scoped state a thread can be
stuck in. Every state drawn is reachable from every other by typing the next
sentence.

### ⭐ The load-bearing finding — the confirm bar MOUNTS today, and three canvas controls ride on it

Measured in the shipped component rather than assumed.
`PlanningWorkspaceHost` renders the confirm bar as a `shrink-0` flex **sibling
below** a `min-h-0 flex-1` canvas box, conditionally
(`state.review && !state.decided && !index.isEmpty`). So the bar mounts and
unmounts, and the canvas box grows and shrinks by its full height.

That would be nearly harmless if the canvas were a static page. It is not:
`ProjectRoadmapCanvas` anchors **three control clusters to the bottom of that
box** — the engine's zoom + fit cluster (`bottom-4 left-4`), the LOCATE control
(`bottom-4 left-[8.25rem]`) and the full-screen control (`right-3 bottom-4`).
Alternating between a question and a change — the exact rhythm this story invites
— would make the canvas's own furniture hop on every turn. The nodes do **not**
move (there is no `ResizeObserver` and no fit-on-resize, so pan and zoom survive);
the jump is entirely in the bottom-anchored chrome, which is why the fix belongs
to the **box** and costs nothing else.

**The answer: ONE footer slot, always mounted, two contents.**

|             | Resting (post-answer, and every state with no pending proposal)                                                                                                    | Proposal pending                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **box**     | identical — `border-t --el-border`, `bg --el-surface`, `px-4 py-2.5`, and a two-line text column whose lines BOTH `truncate`. **57 px, measured, in both states.** |
| **line 1**  | "Roadmap — as saved" · `--el-text-secondary`, 600                                                                                                                  | "1 added · 1 changed" · `--el-text`, 650 |
| **line 2**  | "Nothing proposed. The conversation has changed nothing."                                                                                                          | "Nothing is saved yet."                  |
| **actions** | none                                                                                                                                                               | Discard (ghost) · Approve (primary)      |

**The truncation is load-bearing.** The heights match STRUCTURALLY — same box,
same two type sizes — rather than by a pinned `min-h`, which would drift the
moment the bar's own content changed. Both lines truncate (the shipped bar's own
recipe), so neither state can grow a third line: let the title wrap and the gate
measures 64 px against the resting slot's 57, and the jump is back.

The bar does **not** animate out, because it never leaves: a 120 ms opacity
cross-fade of the contents, no transform and no height animation. What this costs
the shipped code is one level of nesting — the conditional **mount** becomes a
conditional **content**, on the same predicate — which is why "chrome follows the
turn" is a composition here and not a redesign. `PlanChangeConfirmBar` itself is
untouched.

The resting slot is deliberately **not** a status bar that accumulates things to
say: it has exactly those two lines in every non-proposal state. Its second line
is the ask's own promise made visible — **an ask writes nothing** — at the one
moment a person might wonder whether their question moved something.

### The cited answer turn — citations are INLINE, and the count line is not a second list

An answer is an **ordinary assistant bubble**: same fill, ink, avatar and width
as the opener and the planner's findings report. It needs no new treatment to
read as Motir speaking — the finding MOTIR-2225 already made.

**Citations sit inline, in the prose that rests on them**, rendered by the
shipped path (`MarkdownView` → `WorkItemRefChip`). Three grounds, the first
decisive:

1. **The rail already cites inline.** An assistant findings report renders its
   `[KEY](motir:<id>)` tokens through exactly that path, and the shipped
   component says so in the imperative — _"never a second inline treatment
   invented for this surface."_ A trailing source list would be a second citation
   treatment on the same bubble in the same rail.
2. **The mirror links inline.** Rovo and Linear both render references in the
   sentence; the numbered-footnote model belongs to a full-page answer surface,
   and in a 332 px rail a bibliography routinely out-lengths the answer.
3. **Checkability.** A citation beside the **claim** says which sentence rests on
   what. A trailing list says only what was read.

The envelope's `citations` array is the grounding **contract**, and an answer may
rest on items the prose never names — so one quiet line inside the bubble,
_"Answered from 6 work items"_, states the size of the evidence base without
re-rendering it. It is a **number**; the two treatments cannot be confused.

**A user turn is plain text.** The shipped rail renders `{turn.body}` for a user
bubble and `<MarkdownView>` only for an assistant one, so a key the person typed
stays a key and a chip appears only where Motir cited something. That asymmetry
is shipped and is kept.

### The two turn kinds are deliberately NOT differentiated by their bubble

Tinting answers would say "these are two conversations", which is the one thing
this story exists to deny. What separates them is **what each turn carries** —
citations and a count line, or a "Sent to Motir AI" submission marker and a
canvas state — every one of which is meaningful on its own. No distinction rests
on colour alone. A question asked mid-review does **not** discard the pending
proposal: `state.review` is what the footer reads, and an ask writes nothing to
it. Asking mid-review is a lookup, not an abandonment.

### The correction marker, and the redirect's second stream

The marker sits under the **assistant** turn — the moment the user discovers the
mis-read — as a single centred line in the shipped marker vocabulary. Two labels:
**"Propose changes instead"** under an answer, **"Answer this instead"** under a
proposal. It re-runs the **original user turn** under the other intent (no second
user turn), appends a **new** assistant turn, and leaves the superseded one on the
thread undimmed and unstruck — a correction is a second answer, not an erasure.
Only the latest assistant turn carries a marker, so a thread never offers two ways
to re-run the same turn. It is an interactive marker (`--el-link`, underlined, a
real `<button>` in the tab order), distinguished from the passive ones by ink AND
underline; while the re-run streams it becomes a disabled _"Re-reading…"_ rather
than disappearing, and once it fires a passive line — _"Re-read as a plan
change"_ / _"Re-read as a question"_ — says why a second assistant turn exists.

Because `ask` is the one door, a plan-change turn **streams twice** (ADR
Consequence 3). The rail draws **one continuous waiting state** across both jobs:
the waiting bubble never unmounts, its text is swapped in place, and the hand-off
is named in a marker — _"Reading it as a plan change — working on the
proposal"_ — because it is provenance, not conversation. The footer slot stays
**resting** until the proposal exists. A failure in either stream lands in the
shipped error state; Motir never falls through to the other intent.

### The door — one row, one starter, one widened sentence

The row is a **single entry** in `aiCalloutActions()` — icon
`message-circle-question` (the name the shipped registry already reserves in its
own comment), title **"Ask about this project"**, description **"Answer questions
about the plan, docs and work items"** — drawn to the row anatomy MOTIR-1811
specifies, carrying the same `planningWorkspaceHref(context)` every other row
carries. Nothing in `AiCalloutMenu` or on the orb changes.

**The row seeds NOTHING into the composer; the STARTER SET grows by one.** The
rail already has the mechanism the shipped spec's "seed the composer's starter
phrasing" describes — `STARTERS`, chips that **prefill** the composer on click and
never send. So the seed is one more chip, _"What's blocked, and why?"_, and it
belongs to the **surface** rather than to the row: it shows however the user
arrived. A pre-filled **value** was rejected on two grounds — it is in the way of
anyone who wanted to ask something else, and a stub sent unedited becomes a real
turn that costs a real job. A starter chip cannot be sent by accident, and being
surface-scoped it provably carries no intent through the door (§5).

**The opener widens.** Shipped copy is _"What should change?"_, which is now half
the truth and quietly discourages the other half. It becomes **"What should
change — or what would you like to know?"** — one sentence, both capabilities,
still one thread.

### The states

Six, and the fourth is the one that matters. **No confident answer** is an honest
_"I can't answer that from this project"_ — an ordinary bubble, not an error,
because nothing went wrong — and it is still a **cited** answer: it says what it
searched (_"Searched 214 work items and 3 decision records"_), so "I don't know"
is checkable rather than a shrug. **Error** and **out-of-credits** are the shipped
rail error slot and the shipped gateway gate (MOTIR-803), composed unchanged; what
this asset records is that an **ask** reaches them too. The footer slot is
**resting** in all six unless a proposal is pending from an earlier turn.

### Primitives composed (no hand-rolling)

| Element                                     | Shipped owner                                                  |
| ------------------------------------------- | -------------------------------------------------------------- |
| two-pane workspace frame                    | `planning-workspace.mock.html` · `PlanningWorkspaceHost`       |
| rail shell · head · turn list · composer    | `plan-change-conversation.mock.html` · `PlanChangeRail`        |
| bubble · marker vocabulary · asking variant | `plan-change-planner-speaks.mock.html` (MOTIR-2225)            |
| roadmap canvas · diff rings · its controls  | `design/roadmap/` · `ProjectRoadmapCanvas`                     |
| confirm bar                                 | `PlanChangeConfirmBar` — **unchanged**; it moves INTO the slot |
| callout panel · row anatomy · keyboard      | `ai-callout-menu.mock.html` (MOTIR-1811)                       |
| the assistant avatar's MARK                 | the glyph design (MOTIR-3183) · `BrandMark` · `waveBand.ts`    |
| citation chip                               | `WorkItemRefChip` · `markdown-editor.css`                      |
| error · out-of-credits                      | the shipped rail error slot · the gateway gate (MOTIR-803)     |

### Token / a11y discipline

| New element                 | Ink on fill                                        | Light / dark     |
| --------------------------- | -------------------------------------------------- | ---------------- |
| count line                  | `--el-text-secondary` on `--el-surface-soft`       | 6.51 / ≥6 ✓      |
| correction marker           | `--el-link` on `--el-surface` — **and underlined** | AA ✓             |
| hand-off marker             | `--el-text-secondary` on `--el-surface`            | 6.24 / ≥6 ✓      |
| footer slot · resting lines | `--el-text-secondary` on `--el-surface`            | 6.24 / ≥6 ✓      |
| ask starter chip            | `--el-text-strong` on `--el-tint-lavender`         | tint-bg recipe ✓ |
| callout row description     | `--el-text-secondary` — shipped                    | as shipped       |

**Neither `--el-text-muted` nor `--el-text-faint` carries text anywhere in the
asset.** Muted clears AA only on the white page (4.54, 0.04 of headroom) and every
surface here is `--el-surface` or `--el-surface-soft`, where it measures
4.17–4.34 and fails. Faint clears AA on nothing; its one appearance is the shipped
chip's 6 px status **dot** — a `background`, not an ink, carrying no text and
pairing its hue with a position.

Shape flows through element-semantic tokens only — `--radius-card`,
`--radius-control`, `--radius-btn`, `--radius-badge`, `--radius-input`,
`--spacing-control-*`, `--spacing-chip-*`, `--spacing-kbd-*`, `--height-btn-sm`,
`--height-input`. No raw hue anywhere: the two `color-mix()` gradients are the
shipped callout's own, over `--el-*` inputs only. The correction marker is a real
`<button>` in the tab order with `--focus-ring-color` on focus-visible; the
citation chip keeps its shipped hover / focus treatment and its **peek** click, so
"click a citation, then keep talking" is true without this asset designing
anything; decorative glyphs are `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `ask-answers.mock.html` (source) · `ask-answers.png` (full-page
Playwright chromium export, light, `deviceScaleFactor: 2`, 1200 px wide);
`prettier --check` clean. Composes `planning-workspace.mock.html` (MOTIR-1193) +
`plan-change-conversation.mock.html` (MOTIR-1727) +
`plan-change-planner-speaks.mock.html` (MOTIR-2225) +
`ai-callout-menu.mock.html` (MOTIR-1811); bound by
`docs/decisions/conversation-turn-intent.md` (MOTIR-1816); gates the code subtask
**MOTIR-1820**.

---

## ⭐ The run surface while it is RUNNING — a live composer, a stop, and a run that ended on purpose (MOTIR-4066, 2026-09-03)

**Amendment to this asset set, for `MOTIR-4066`.** The rail shipped by
`MOTIR-2226` draws a run that is **watched**. Story `MOTIR-4054` makes it a run
that is **participated in**, and that is a different surface: the composer stays
live while the planner works, a control can end the run, and a run can now finish
in a state that is neither success nor failure. None of those had a drawing. The
three cards under that story — **MOTIR-4067** (the mailbox), **MOTIR-4068** (the
stop), **MOTIR-4069** (the rail narrates every act) — consume this asset; none of
them decides what it shows.

**Asset:** `plan-change-run-live.mock.html` (source) + `plan-change-run-live.png`.
A five-sheet board: the entrance, the four states against one layout, the act-kind
table, the anatomy + token map (light and the real dark flip), and the measured
viewport table.

| Sheet | What it shows                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| **1** | **The entrance** — where the **Stop** lives, and why it is reachable at the moment it is wanted                                |
| **2** | **The four states against ONE 22rem rail**: running · running-and-typed · stopping · stopped, plus the queued-vs-consumed pair |
| **3** | **The act rail** — every frame kind the contract carries, `retrieval` beside them, and the LOUD unknown                        |
| **4** | **Anatomy + the token map**, and the stopped state asserted **by absence** — what it may not use                               |
| **5** | **Measured** — how many act lines fit at each viewport, and what follows from the answer                                       |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn

Every rail fragment on the board is the **real emitted markup** of the shipped
`components/planning/PlanChangeRail.tsx` + `PlanChangeComposer.tsx`, captured by a
headless render of the actual components in the `streaming` phase (the repo's own
`tests/helpers/renderWithIntl` harness → `container.innerHTML`) at the rail's real
`22rem`. Five things the render corrected, versus what reading the `.tsx` alone
would have suggested — and the first is the largest thing on this board:

- **THE COMPOSER IS `disabled` FOR THE WHOLE RUN.** `busy = state.phase === 'streaming'`
  reaches the `@` trigger, the text input **and** Send; all three carry a real
  `disabled` attribute in the emitted markup. _"The composer stays live"_ is
  therefore a **behaviour** change, not a styling one.
- **THE PROGRESS REGION IS ONE REPLACING LINE, not a rail.** A single
  `aria-live="polite"` div (`data-testid="plan-change-progress"`) holding a spinner
  and the current narration, overwritten on every frame. **A run's whole history is
  one sentence long today.**
- **THE MARKER LINE IS `--el-text-secondary`**, not `--el-text-faint` as the
  MOTIR-2225 section above states. The notes drifted from the component; the render
  is the truth, and the two new marker lines here follow the component.
- **THE USER BUBBLE IS `--el-chat-bubble-user`** with a `--el-muted` avatar (the
  MOTIR-2225 section says "accent fill"), and the `label` slot
  (`font-mono text-[10px] uppercase opacity-80`) renders **inside** the bubble —
  which is why the `queued` state fills that slot rather than inventing a header.
- **THERE IS NO STOP CONTROL ANYWHERE**, at any phase, in any of the three
  components.

### ⭐ The load-bearing decision: a stop is a DECISION, not a failure

The whole card turns on this, and it is expressible as a prohibition rather than a
treatment:

> **The stopped state borrows nothing from the error state.**

If stopping reads as throwing work away, people will not stop runs — they will wait
them out, and the control is decorative. That is a product failure with no error to
trace. So the stopped state is asserted **by absence**, and sheet 4 lists what it
may not use so a reviewer checks a claim rather than an impression:

| not used                                        | why it would be wrong                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--el-tint-rose` + `role="alert"`               | the rail's OWN error affordance (`PlanChangeRail`'s error block). Absent from every stopped frame                       |
| `--el-warning-surface` / `--el-warning-text`    | spoken for by the **asking** state (MOTIR-2225); two warm pending-ish states one scroll apart are less legible than one |
| `--el-destructive`                              | nothing is destroyed — the plan survives a stop intact                                                                  |
| `triangle-alert` · `circle-x` · `octagon-alert` | no failure iconography anywhere                                                                                         |
| dimming, strike-through, grey-out               | a stopped run's proposals are worth what they were worth a second earlier                                               |

**And the reviewability is drawn by REUSE, not by a new element:** the stopped rail
carries the shipped `plan-change-review` block — `--el-accent` border, _"Nothing is
saved yet."_, Discard + Approve — **live**. That is the strongest available way to
say the plan still stands: it is literally the same block a completed run shows.

### The states (A–D, sheet 2)

| State | What it is                       | How it is drawn                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **RUNNING — nothing said**       | The composer is live and empty. The act rail accumulates; the newest line carries the spinner and is the one line at full `--el-text` ink. The **running bar** sits pinned above the composer input with the live line and **Stop**                                                                                  |
| **B** | **RUNNING — the user has typed** | The turn is an ordinary user bubble — **not re-tinted** — whose `label` slot reads `queued` with a `clock` glyph, plus a marker line: _"Queued — Motir AI reads this when it finishes the card it is writing."_                                                                                                      |
| **C** | **STOPPING**                     | The click is not the stop: the walk reads the flag at its next phase boundary, which can be a whole authoring session away. The bar keeps spinning, **Stop** becomes `disabled` and relabelled **Stopping…**, and the act rail gains a `stopping` line. The surface never claims a terminal state it has not reached |
| **D** | **STOPPED**                      | A `stopped` act line at full ink, one centred marker (_"You stopped this run."_), and the shipped review block live underneath it                                                                                                                                                                                    |

**B, one boundary later.** The queued and the delivered-and-acted-on states are
visibly distinct, and the distinction is **textual and structural rather than
chromatic** — four cues, none of them colour: the label slot changes
(`queued` → `turn 2`), the clock glyph goes, the marker line is replaced with
_"Read at the boundary — folded into this run."_, and a `folded` act line appears
in the rail saying what the run did with it.

**Why the queued bubble is not re-tinted.** The obvious move is a warm tint on the
pending turn, and it is wrong here: `--el-warning-surface` already carries the
planner's **asking** state on this exact surface, and two warm pending-ish states
one scroll apart are less legible than one — the same reasoning MOTIR-2225 used to
keep the report bubble ordinary.

### ⚠️ THE ENTRANCE — the pinned footer, and only there

The moment a stop is wanted is the moment the run is visibly going wrong and the
user is already annoyed. So it may not be on hover, and it may not be below a
scroll. The rail has exactly one region that is always on screen: the **pinned
composer footer**, outside the `overflow-y-auto` transcript. MOTIR-2225 put the
answer bar there for the same reason and measured why — at `22rem` the header row
already carries the status dot, `Motir AI` and the mode chip, and a fourth element
truncates. **The running bar takes that slot**, on the same fill the shipped
progress row already uses.

**No second door.** A keyboard shortcut, a canvas-bar stop and a context-menu entry
were considered and rejected: three entrances to one control is three things to
keep in sync, and the pinned one already answers the question. If a second is ever
wanted it belongs beside `Esc`-closes in the workspace shell, not in this rail.

### The ACT RAIL — one replacing line becomes a record

The shipped surface renders **one replacing line**. The rail here is an
**accumulating ordered list**, three columns — glyph · mono act label · line —
because the user is now making a decision against it (whether to stop), and a
decision needs the record rather than the latest word.

**The skim axis is the middle column, not colour.** Every act line is the same ink;
what a reader runs their eye down is a fixed-width column of short mono words, with
the glyph as a second, non-textual cue. Deliberate: the rail already carries three
coloured states (assistant, user, the accent review block) and a fourth hue would
compete with them rather than help.

| frame                                 | glyph                      | the line                                                          |
| ------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `submitted`                           | `send`                     | Sending the conversation to Motir AI…                             |
| `reading`                             | `scan-search`              | Reading your request…                                             |
| `redirected`                          | `corner-down-right`        | Working on the proposal…                                          |
| **`retrieval`**                       | **`book-open-text`**       | **Read the plan tree · code graph · code health · web · lessons** |
| **`retrieval` (blocked)**             | **`ban`**                  | **Out of lookups — carrying on with what it has.**                |
| `search`                              | `search`                   | Reading your plan…                                                |
| `drill`                               | `list-tree`                | Working through the tree…                                         |
| `pass` · `planned` · `level_complete` | `sparkles`                 | N items proposed so far…                                          |
| `validated` · `validation_skipped`    | `shield-check`             | Checking the proposal against your plan…                          |
| **anything else**                     | **`circle-question-mark`** | **`frame: <the raw kind>`**                                       |

`retrieval` is the frame this card exists for: the planner emits it on every graph
lookup carrying `{ tool, family }` over five families — `plan_tree`, `code_graph`,
`code_health`, `web`, `lessons` — plus a `blocked: true` variant when the per-job
retrieval budget is spent, and nothing renders any of it.

**The last row is the point, not a footnote.** Adding a `retrieval` arm fixes
today's symptom and leaves the mechanism: `default: return null` means every frame
kind added upstream is invisible, with no signature — nothing throws, nothing logs,
the rail just says less than the run did. So the unknown kind gets a drawn line of
its own, loud enough that a developer sees it and quiet enough that it is not an
error for a user, because it is not one.

**Ordering, and the one thing the rail must not do.** Act lines append. They are
never re-ordered, never collapsed and never de-duplicated: two `retrieval` lines in
a row mean the planner made two lookups, and a rail that folds them into "2
lookups" has turned a record into a summary. The _only_ line that changes after it
is written is the live one, which loses its spinner when the next act arrives.

### ⭐ MEASURED — and the number decides the layout

Measured in chromium against the shipped rail markup inside the real two-pane
shell, act lines added until the transcript overflows. Not estimated.

| viewport                   | usable px (−~120 chrome) | act lines, rail alone | act lines, after the ordinary opening |
| -------------------------- | ------------------------ | --------------------- | ------------------------------------- |
| **1366 × 768** (the floor) | 648                      | 17                    | **9**                                 |
| 1280 × 800                 | 680                      | 18                    | **10**                                |
| 1440 × 900                 | 780                      | 23                    | **15**                                |
| 1512 × 982                 | 862                      | 27                    | **19**                                |

**The finding is nine.** With the ordinary opening above it — the assistant opener,
one user turn, the _Sent to Motir AI_ marker — nine act lines fit at the floor
before the transcript scrolls, and a real planning run emits several times that. So
the rail **will** scroll, on the most common laptop, in the first thirty seconds.
The question was never whether to prevent that but what has to remain visible when
it happens, and two things follow — both drawn: the live line is **duplicated into
the pinned bar**, and **Stop** lives in the pinned footer rather than beside the act
it would end.

**The invariant, for the cards that build it:** the transcript scrolls and the
footer does not. The running bar, the composer and the **Stop** button are never
inside the scroll region — at any viewport, at any run length. A build that puts the
bar in the transcript passes every unit test and breaks the only claim sheet 1
makes. **And the rail auto-scrolls to the newest act while the user has not scrolled
away**; a reader who scrolled up to re-read an earlier act is reading deliberately,
and the pinned bar is what makes leaving them alone safe.

### Primitives composed (no hand-rolling)

| Element                                      | Built from                                                                                                                                                                            | Colour                                       | Shape                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| the rail, header, bubbles, markers, composer | the shipped `PlanChangeRail` / `PlanChangeComposer` — real emitted markup                                                                                                             | as shipped                                   | as shipped                        |
| **act rail**                                 | NEW — an `<ol>` in the transcript, replacing the one-line `plan-change-progress` region                                                                                               | `--el-surface-soft` (that region's own fill) | `--radius-card`                   |
| **act line, past**                           | glyph + mono label + line                                                                                                                                                             | `--el-text-secondary`                        | —                                 |
| **act line, live / outcome**                 | the same row, spinner in the glyph slot                                                                                                                                               | `--el-text`                                  | —                                 |
| **act label column**                         | the shipped label-slot type                                                                                                                                                           | `--el-text-secondary`                        | `font-mono text-[10px] uppercase` |
| **running bar**                              | NEW — a sibling in `PlanChangeComposer`, in the answer bar's slot                                                                                                                     | `--el-surface-soft` / `--el-text-secondary`  | `--radius-card`                   |
| **Stop**                                     | `Button variant="secondary" size="sm"` + `circle-stop` — **not** destructive                                                                                                          | `--el-surface` / `--el-border` / `--el-text` | `--radius-btn`, `--height-btn-sm` |
| **queued label**                             | the shipped `label` span, filled, + `clock`                                                                                                                                           | inherits the bubble ink at `opacity-80`      | `font-mono text-[10px] uppercase` |
| **queued / folded / stopped markers**        | the shipped `plan-change-marker` line                                                                                                                                                 | `--el-text-secondary`                        | `text-center text-xs`             |
| the surviving proposal                       | the shipped `plan-change-review` block, reused whole                                                                                                                                  | `--el-accent` border                         | `--radius-card`                   |
| icons                                        | lucide-react — `circle-stop`, `clock`, `book-open-text`, `ban`, `scan-search`, `corner-down-right`, `list-tree`, `shield-check`, `sparkles`, `search`, `send`, `circle-question-mark` | —                                            | —                                 |

### Token / a11y discipline

- **Colour** strictly via `--el-*`. The mock's stylesheet is lifted verbatim from
  `plan-change-planner-speaks.mock.html` — Tailwind's real output for this surface
  over `packages/design-system/theme.css` — so the Tier-0 `--color-*`, the
  `[data-theme='dark']` flip and the Tier-3 `--el-*` layer are the shipped values.
  **No retyped hex, no invented hue, and no missing token was found.** A short
  supplemental block adds only the utilities Tailwind emits for the new markup
  (`truncate`, `size-3.5`, `w-16`, `mt-px`, the spinner's four) — none of them
  carries a colour.
- **Shape** strictly via element-semantic tokens (`--radius-card|control|input|btn|badge`,
  `--spacing-chip-x/y`, `--spacing-control-x/y`, `--spacing-icon-btn`,
  `--height-btn-sm`, `--height-input`), so a `data-style` swap reshapes the running
  bar exactly as it reshapes the bubbles.
- **Not colour alone** — every new state pairs its treatment with a word AND a
  glyph: `queued` + `clock`, **Stopping…** + a disabled control, `stopped` +
  `circle-stop`, and a marker line in every case. **No dashed or dotted border
  carries a state**, which would fight the `data-style` axis and collide with the
  canvas's proposed-node language.
- **Dark** is the real token flip (`data-theme="dark"` **plus**
  `data-appearance-scope`, since the Tier-3 layer is declared on
  `:root,[data-appearance-scope]` and a nested subtree must re-emit it). The states
  stay distinguishable in both themes for the same reason they do in light — the
  distinction never rested on a hue.
- **A11y** — the act rail is the `aria-live="polite"` region the shipped progress
  line already was, so the newest act is announced without a second live region
  competing with the transcript's `role="log"`. **Stop** is a real `<button>` with a
  visible label (never an icon-only control), and its `disabled` **Stopping…** state
  keeps the label in text so the interval is announced rather than only shown.
  Decorative glyphs are `aria-hidden`; the spinner keeps its shipped
  `role="status"`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `plan-change-run-live.mock.html` (source) ·
`plan-change-run-live.png` (full-page Playwright chromium export, light,
`deviceScaleFactor: 2`, 1580 px wide); `prettier --check` clean. Composes
`plan-change-planner-speaks.mock.html` (MOTIR-2225) +
`plan-change-conversation.mock.html` (MOTIR-1727) and the shipped
`PlanChangeRail` / `PlanChangeComposer`; grounded in the consumer half already
merged in `motir-ai` (**MOTIR-4060**'s boundary mailbox); gates **MOTIR-4067**,
**MOTIR-4068** and **MOTIR-4069**.

---

## ⭐ The plan surface READING the project, and the two hand-offs out of it (MOTIR-4766, 2026-09-06)

**Asset:** `reading-and-handoff.mock.html` + `reading-and-handoff.png`, six panels.
**Story:** MOTIR-4753 — _the DEPTH of onboarding is a judgement about the project's SUBSTRATE_.

### Why this is a NEW surface in this area rather than a panel on `planning-workspace`

`planning-workspace.mock.html` draws the workspace AT WORK — its canvas, its rail, its overlay
frame, its exits. This asset draws the ~15 seconds **before any of that exists** for a project that
has never been planned, and the two doors out of it. Different moment, different reader question,
its own three-file set. The overlay CHROME is composed from that asset's sheet 6, never redrawn.

### The change this asset is the visual half of

MOTIR-4765 removes the gate. Until it lands, `resolvePlanningHostGate` returns `'onboarding'`
whenever `Project.onboardingRanAt` is null and `PlanningWorkspaceOverlay` `router.push()`es to
`/onboarding` — so pressing **Plan with AI** on a project with a connected, indexed repository ejects
the user to a wizard. After it, the window OPENS, a session READS the project, and **the planner**
decides one of three things (MOTIR-4767): `continue`, `onboard_new_project`,
`onboard_existing_project`. Panels 1–2 exist because the window now opens; panels 3–4 are the two
onboarding outcomes; panel 6's last cell is `continue`.

### Where each depicted behaviour comes from (grounding, not invention)

| Panel                           | Grounded in                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–2 · the READING state         | **MOTIR-4768** — it NAMES the connected repository and the committed work items, from `readOnboardingSubstrate`; "a statement of activity, not a progress bar" is that card's own wording. |
| the four values named on screen | **MOTIR-4756** — `itemCount`, `itemCountTruncated`, `repositoryConnected`, `repositoryIndexed`, and `ONBOARDING_SUBSTRATE_ITEM_CAP = 200`.                                                 |
| 3–4 · the two hand-offs         | **MOTIR-4767** — the three outcomes, and on `onboard_existing_project` the KEPT STEPS and WHAT IS MISSING.                                                                                 |
| the move is SHOWN, not silent   | **MOTIR-4769** — "the hand-off is SHOWN before it happens… the move is not a silent redirect out from under them."                                                                         |
| 5 · the RETURN, and abandonment | **MOTIR-4770** — the launch context travels with the move, onboarding returns the user to the window they opened, and a user who walks away lands on an ordinary page.                     |
| the kept-step chips             | **MOTIR-4759** renders the set; **`design/onboarding-migrate/` Panel 6** is the rail it renders into. Same `satisfied` vocabulary, said once here and once there.                          |

### Panel 1–2 · THE READING STATE

**It names the things, and that is the whole design.** A spinner says _something is happening_; this
says _I am reading acme/widgets, acme/widgets-api and 214 work items_ — the product demonstrating in
one sentence the thing the story argues for, before any plan exists to judge. Three `.src` rows, one
per named source: repository rows come from `repositoryConnected`, and `repositoryIndexed` decides
whether the sub-line can say _Code graph ready_; the third row is `itemCount`.

**NOT a progress bar**, and the constraint is MOTIR-4768's own: nothing on this path knows a
duration. A bar has a track, a fill and therefore a claim about how far along it is, and it would
have to keep that claim while a model call sits in the middle of it. Three quiet dots and _usually
takes a few seconds_ promise only what is true.

**The cap is drawn.** At `itemCountTruncated: true` the row reads **200+ work items · Reading the
most recent 200**, never an exact _200_. The read explicitly reports the count as a FLOOR, and the
surface may not upgrade it into a total — it is the same number the planner's judgement is about to
be based on.

**The THIN substrate is a SENTENCE, never an empty list.** Three rows with _none_ beside each is a
report card, handed to the user in the four seconds before they are moved somewhere — which turns
the move into a verdict on them. The sentence states the same fact and carries a clause the list
cannot: _that's normal for a new project, and it's the next thing we'll fix together_. The heading
changes with it — _Having a look at your project_, not _Reading_, because there is nothing to read.
It commits to nothing about the destination: the routing is the planner's and it has not answered
yet.

### Panel 3–4 · THE TWO HAND-OFFS

**They are told apart by STRUCTURE, not by a colour** — which is what makes them distinguishable at
a glance and in a screen reader alike.

|              | A · `onboard_new_project`                       | B · `onboard_existing_project`                              |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| heading      | _Let's set your project up first_               | _Two things I still need_ (it COUNTS)                       |
| found block  | — (there is nothing to have found)              | `.found` — _I read **acme/widgets** and **214 work items**_ |
| missing list | —                                               | `.missing` — the planner's own words, rendered              |
| kept steps   | —                                               | `.kept` — one `run` chip, three `satisfied` chips           |
| actions      | _Set up my project_ · _Not now_                 | _Fill in the gaps_ · _Not now_                              |
| closing line | _you'll land back in this window ready to plan_ | _straight back here and we can get planning_                |

**Every word of the missing list is the planner's** (MOTIR-4767 returns it); the surface renders it
and writes none of it. It is drawn as a list of gaps — a dashed open circle per row — and NOT as an
error list: no red, no warning triangle. The thing is incomplete, not wrong.

**The kept-step strip is the apology this route owes.** MOTIR-4767's own argument: sending someone to
re-connect a repository they connected last week is the same insult as the interview, one surface
along. So the strip shows, BEFORE the user commits, what they will be asked (_A few questions_) and
what is already there (_Connect_, _Index_, _Import work items_). The satisfied chips reuse
`design/onboarding-migrate/`'s sky tint and read glyph (Panel 5, MOTIR-4755) rather than inventing a
second way to say the same thing.

**_Not now_ is deliberately present on both.** A user who opened the plan window to look around is
allowed to close it again, and a hand-off with one button is a wall with a door painted on it.

### Panel 5 · THE RETURN — a fourth moment, not a mirror of the third

The hand-off says _we need something first_; the return says _we have it — what do you want to plan?_
So it is **not another full-card interstitial**: the workspace is simply there, ready to do what the
user pressed the button for, and the acknowledgement is one line in the conversation —

> ✓ You answered the two questions. Picking up where we left off.

#### ⚠️ THE PLANNER ASKS — it does NOT hand over a plan (Yue, 2026-09-06)

The first revision of this panel drew the canvas full of dashed proposals and a footer reading _42
proposed work items · nothing is added until you say so_, with the planner opening on _"here's a plan
across acme/widgets and all 214 of your items — 42 work items, in six pieces"_. **That is not what a
planning session is.** A regular session **arrives with the context and WAITS to be told what to
plan**; it asks, it does not propose a tree unprompted. It is also exactly what `continue` means one
repository over (**MOTIR-4767**: _the session asks and plans exactly as a regular session does_).

So the panel draws: the canvas showing the project **as it stands** — the items that are already
there, no proposals; a footer saying what the session can **see** (`214 work items` ·
_acme/widgets · code graph ready_) rather than what it has produced; the planner's turn ending in a
**question**; and a live, empty composer reading _Tell Motir what to plan…_. The two hand-off panels'
closing lines were corrected in the same pass for the same reason — they promised _a plan waiting_
and now promise _ready to plan_.

**The same correction removed `design/onboarding-migrate/`'s Panel 0**, which drew the identical
mistake at the end of the migrate wizard (finished-step done-cards, a _"here's a plan grounded in your
code"_ lead, a canvas of proposed subtasks, a confirm bar). Nothing about the end of that wizard is
migrate-specific: it opens the universal plan window and the regular session begins. See
`design/onboarding-migrate/design-notes.md` §Panel 0.

**The line sits in the RAIL because the rail is where the session speaks.** A toast would fade; a
banner over the canvas would put chrome between the user and the thing they came back for.

**The earlier turns are still above it**, and that is the design claim MOTIR-4770 AC5 makes
checkable: the conversation is a persisted server thread (`usePlanChangeConversation`'s resume
payload, re-read on mount), so the user comes back to the session they left rather than a new one
that looks similar.

**Nothing in this asset warns about losing a draft.** An earlier draft of the card treated the
route-group unmount as a data hazard; it is not. The thread is a server row, the proposals are
addressed by `planId`, and at the moment of the move the only client-only state — the composer draft
and the local target queue — cannot hold anything, because the verdict is decided in the reader
before any pass runs. MOTIR-4731's confirm-before-close exists for a user CHOOSING to close over a
decision they can see; being routed away seconds after opening is not that situation.

**The ABANDONED path is drawn beside it**: an ordinary authed page, no scrim, no dialog, no re-opened
workspace. Re-opening a window somebody walked away from is the opposite failure to stranding them,
and it is the easier one to write by accident — the return path already knows where to go, so the
temptation is to take it unconditionally. The launch context is a RETURN ADDRESS and it expires.

### Panel 6 · WHAT IT MUST NOT LOOK LIKE

Three surfaces this must never become, drawn so a builder can recognise the pull toward each:

- **Not an error** — _"We couldn't plan your project."_ Nothing failed; the read worked and produced
  a finding.
- **Not a refusal** — _"This project isn't ready for AI planning."_ A judgement about the project
  reads as a judgement about the person who made it. The finding is about what Motir can SEE.
- **Not a dead end** — a card whose only control is Close. The user pressed _Plan with AI_; every
  surface here carries a way onward and says where it leads.

**And the third outcome draws nothing.** `continue` means the reading state resolves straight into an
ordinary planning session — the regular framing, the regular questions, the planner waiting to be
told what to plan — and the user never learns a decision was made about them. That is stated
explicitly in the asset because an asset full of interstitials invites a fourth one saying _Good
news, we can plan this!_ — and nobody needs to be told that the thing they asked for is happening.

### Vocabulary — no string names a direction tier

**No panel, label, chip or annotation in this asset uses "Pre-plan" or names a tier.** MOTIR-4757
retires the term from `messages/` and guards it there; MOTIR-4755 revision 2 collapsed the migrate
rail's four tier-named rows to ONE after Yue's note that a user does not know what Discovery and
Vision are. `discovery` / `vision` / `feasibility` / `validation` are identifiers a kept-step set
travels as; the copy says what the user is doing — _a few short questions about what you're building
and who it's for_.

### Primitives composed (no hand-rolling)

`Modal size="full"` (`rounded-none border-0 p-0`, `hideClose`) as `PlanningWorkspaceOverlay` mounts
it · `PlanningWorkspaceHost`'s top bar with its top-LEFT Close chip and `Esc` `<kbd>` · the
conversation rail (`.rhead` / turns / bubbles / composer) · `Card` for the reading and hand-off
surfaces · `Button` primary + ghost · `Pill` (sky / mint / lavender / neutral) · the
`design/roadmap/` node language for the returned canvas · the shipped `AppLayout` nav + top bar for
the abandoned path. The overlay's two-pane geometry and its 49px top bar are the numbers MOTIR-4726
MEASURED on the real components at 1440×780 and recorded in `planning-workspace.mock.html` § sheet 6;
this asset inherits them and draws the frame taller because the reading card, not the canvas, is its
subject.

### Per-element token roles

| Element                            | colour                                                                                    | shape                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| dialog frame                       | `--el-page-bg`, `--el-border`, `--shadow-card`                                            | `--radius-modal`                                     |
| host top bar                       | `--el-surface`, `--el-border-soft`                                                        | —                                                    |
| Close chip                         | `--el-card` / `--el-border` / `--el-text-strong`; `<kbd>` `--el-text-secondary`           | `--radius-btn`, `<kbd>` `--radius-control`           |
| canvas ground                      | `--el-canvas` + a dot texture in `--el-border`                                            | —                                                    |
| reading / hand-off card            | `--el-card`, `--el-border`, `--shadow-subtle`                                             | `--radius-card`, `--spacing-card-padding`            |
| eyebrow                            | `--el-text-eyebrow`                                                                       | —                                                    |
| card heading · lede                | `--el-text` · `--el-text-secondary`                                                       | —                                                    |
| `.src` row · its icon tile         | `--el-surface-soft` / `--el-border`; tile `--el-tint-sky` + `--el-text-strong`            | `--radius-control`, `--spacing-control-x/y`          |
| _Reading_ chip                     | `--el-tint-sky` + `--el-text-strong`                                                      | `--radius-badge`, `--spacing-chip-x/y`               |
| activity dots                      | `--el-accent` (decorative, `aria-hidden`)                                                 | `--radius-badge`                                     |
| `.found` block                     | `--el-surface-soft` / `--el-border` / `--el-text-secondary`, `<b>` `--el-text-strong`     | `--radius-card`                                      |
| `.missing` row · its gap glyph     | `--el-text`; glyph dashed `--el-border-strong` (`aria-hidden`)                            | `--radius-badge`                                     |
| kept chip · run / satisfied        | `--el-accent` + `--el-accent-text` / `--el-tint-sky` + `--el-text-strong` + `--el-border` | `--radius-badge`, `--spacing-chip-x/y`               |
| buttons — primary / ghost          | `--el-accent` + `--el-accent-text` / `--el-text`                                          | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x` |
| rail                               | `--el-card`, `--el-border`, `--el-border-soft`                                            | —                                                    |
| AI bubble · user bubble            | `--el-surface-soft` + `--el-text` / `--el-accent` + `--el-accent-text`                    | `--radius-card`                                      |
| the return's system line           | `--el-tint-mint` + `--el-text-strong`                                                     | `--radius-control`                                   |
| composer input · its disabled form | `--el-input-border` + `--el-text-secondary` / `--el-muted` + `--el-text-faint`            | `--radius-input`, `--height-control`                 |
| proposal node                      | dashed `--el-accent` on `--el-callout-bg` + `--el-callout-text`                           | `--radius-control`                                   |
| "must not look like" card          | dashed `--el-danger` border; caption `--el-danger-on-surface`; body `--el-text-secondary` | `--radius-card`                                      |

**`--el-danger-text` appears nowhere.** Per `CLAUDE.md` it is the ink FOR a danger FILL and measures
1.00–1.04:1 on a light page in all ten palettes; the three _must not look like_ cards carry the hue
in the BORDER (graphics contrast) and the caption in `--el-danger-on-surface`, with the body copy on
`--el-text-secondary`. Every annotation in the board chrome is `--el-text-secondary` — never
`--el-text-muted`, which fails AA on `--el-surface` / `--el-surface-soft` / `--el-muted`, and never
`--el-text-faint`, which clears AA on nothing. `--el-text-faint` appears once, on the DISABLED
composer, which 1.4.3 exempts. The asset declares `--el-canvas` and `--el-danger-on-surface`
alongside the token block copied from `packages/design-system/theme.css`, because that copy omitted
them; both definitions are theme.css's own, verbatim.

### Deliverable

`design/ai-chat/reading-and-handoff.mock.html` · `design/ai-chat/reading-and-handoff.png` (1200
viewport, `deviceScaleFactor: 2`) · this section. The migrate half — the rail that renders the kept
set — is `design/onboarding-migrate/design-notes.md` § _AMENDMENT (2026-09-06 · MOTIR-4766)_ and
Panel 6 of that area's mock, published under the same card.

### ⭐ AMENDMENT (2026-09-07 · MOTIR-4825) — Panel 7 · the THIRD reading state: connected, and no code graph yet

The two reading states above assume the code can be read. **A repository can be CONNECTED and have no
graph** — an index that failed, one still running, or a person who connected their repository and
pressed **Plan with AI** a minute later. In that state every graph tool answers empty, and empty is
indistinguishable from a repository with nothing in it, so the honest-looking route is onboarding —
a questionnaire about a codebase Motir was thirty seconds from being able to read. Panel 7 is what
the surface does instead.

#### ⚠️ TWO INSTRUMENTS, AND NEITHER IS THE OTHER'S CAPTION (Yue, 2026-09-07)

This is the load-bearing decision of the panel, and it was settled twice in one turn — first
_"the planner SHOULD tell the user, the repo is being indexed"_, then _"with the banner and say
it"_.

|                        | what it carries                                                                                                                            | where it lives                                                                      | how it ends                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------- |
| **THE BANNER**         | the STATE — the repository, that it is being indexed, and whether that has started or is under way                                         | pinned at the top of the window body, ABOVE the reading card                        | disappears when the index lands |
| **THE PLANNER'S TURN** | the REASON — in the second person, naming their repository, saying a good plan needs the code and that planning starts when the index does | the conversation rail, rendered exactly as panels 3–4 render an outcome's `message` | scrolls, like any turn          |

**Why both.** A banner alone leaves somebody guessing why they are waiting; a turn alone puts a
durable state into a transcript that scrolls away, so a person who comes back two minutes later has
to read history to find out whether anything is happening. They are answering different questions —
_what is happening_ and _why am I waiting_ — and the failure mode of collapsing them is silent: the
build that keeps only the banner looks finished.

**The turn is the VERDICT's own `message`, not product copy.** That is the whole reason the fourth
routing outcome is a `motir-ai` card: `MOTIR-4767` AC10 requires `message` on every outcome,
REFUSED rather than defaulted, _"because a stand-in sentence written at the parse seam would be
Motir speaking in the planner's voice about a project it did not read"_. Here it HAS read something
— that there is nothing to read yet — and says so.

#### The banner's two live wordings

`Queued` and `In progress` differ in the **tail pill** and the **sub-line**, and never in the title.
The person is waiting for the same thing either way, and a title that changes under them reads as a
second event; the tail is the one place the distinction earns its keep, because it is what tells
somebody who came back whether anything has moved.

- **Queued** — _Indexing acme/widgets_ · _Just started_ · tail `Queued`
- **In progress** — _Indexing acme/widgets_ · _Reading the code so the plan can start from it_ · tail `In progress`

#### ⚠️ STILL NOT A PROGRESS BAR — panel 1's rule, and the same reason

`motir-core` is told an index has SUCCEEDED and is never told how far along it is, so a track and a
fill would be a claim nothing can support. Three dots and the two tail wordings are the entire
affordance. This is not a fresh judgement: it is Panel 1's _NOT A PROGRESS BAR_ note holding on a
second state, and it would be the easiest thing in this asset to break, because indexing FEELS like
the one wait that has a percentage.

#### The EXIT, drawn because the person opened this window to plan

The reading card says it in one line — _"You can close this and come back — it keeps going without
you."_ — and the composer's disabled form says _"Ready as soon as the index is"_ rather than going
silent. **When the index lands the window moves on by itself**: the reading state is a client
island, so it refetches on an authoritative read rather than waiting to be reloaded. Nobody has to
come back and press anything.

#### The FAILED arm — one of the three ways this state is reached at all

An index can fail, and Panel 6's _not a dead end_ rule binds here as much as anywhere: the failed
banner carries **two** ways onward.

- **Try again** re-enqueues.
- **Plan anyway** hands the routing run a project with no readable repository — a case the verdict
  already knows, so it becomes an ordinary onboarding route rather than a bespoke failure path.

The copy names no cause it has not been told (`motir-core` learns that an index did not succeed, not
why) and apologises for no bug: _"I couldn't index acme/widgets — nothing is lost."_

#### Per-element token roles (panel 7 only)

| element                                   | colour                                                                                 | shape                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| indexing banner                           | `--el-tint-sky` on `--el-border-soft`                                                  | `--radius-card`, `--spacing-control-x/y` |
| its title                                 | `--el-text-strong`                                                                     | —                                        |
| its sub-line                              | `--el-text-secondary`                                                                  | —                                        |
| its tail chip                             | `.pill.sky` — `--el-tint-sky` + `--el-text-strong`                                     | `--radius-badge`, `--spacing-chip-x/y`   |
| the three dots                            | `--el-text-secondary`                                                                  | `999px` (circular — not style-dependent) |
| FAILED banner                             | `--el-danger-surface`, border `--el-danger-on-surface`                                 | `--radius-card`                          |
| its warning glyph                         | `--el-danger-on-surface`                                                               | —                                        |
| its title · sub-line                      | `--el-text` · `--el-text-secondary`                                                    | —                                        |
| its two buttons                           | `.btn.sm.primary` / `.btn.sm.ghost` — `--el-accent` + `--el-accent-text` / `--el-text` | `--radius-btn`, `--height-btn-sm`        |
| source rows, reading card, rail, composer | unchanged — composed from panels 1–2                                                   | unchanged                                |

**Why the sky pair clears AA, stated rather than assumed.** `--el-tint-sky` is this asset's own
tinted-surface convention and it already carries `--el-text-strong` on `.pill.sky` and on the source
rows; the sub-line takes **`--el-text-secondary`**, which is 6.18–6.80:1 on every grey surface in
both themes and is the token `CLAUDE.md` names as right whichever surface an element lands on.
**`--el-text-muted` is NOT used here**: its 4.54:1 was measured on the white page and it fails on
`--el-surface` / `--el-surface-soft` / `--el-muted`, and a tint is not the surface that reading was
taken on. The FAILED banner keeps its LABEL on `--el-text` and puts the hue in the GLYPH and the
BORDER — the composition `CLAUDE.md` prefers for a large danger label, since graphics need only
3:1 — so **`--el-danger-text` appears nowhere in this panel either**; it is the ink for a
`--el-danger` FILL and measures 1.00–1.04:1 on a light page.

#### Primitives composed (no hand-rolling)

The overlay frame (`.ws` / `.wcanvas` / `.wtop` / `.wbody`), the reading card, the source rows, the
rail with its AI bubble and its disabled composer, the pills and the buttons are all composed from
panels 1–2 and 3–4 unchanged. **The only new element is the banner itself**, and it is a flex row of
existing tokens rather than a new primitive.

#### Deliverable

`design/ai-chat/reading-and-handoff.mock.html` panel 7 · a re-exported
`design/ai-chat/reading-and-handoff.png` (1200 viewport, `deviceScaleFactor: 2`, `EXACT` against the
committed export) · this section. It AMENDS `MOTIR-4766`'s asset rather than opening a new one:
this is one more state of the same screen — the plan window reading a project — and a separate file
would leave a reader to work out that they are the same surface.

---

## ⭐ The canvas ARRIVES INSIDE the node being planned — the target's children, in both phases (MOTIR-6159, 2026-09-24)

> **Superseded in part by `design/ai-planning/design-notes.md` Part XXVIII (MOTIR-8591, 2026-10-15).**
> On the planning overlay while a plan is `generating`, § _The person who NAVIGATED FIRST_ (never move
> after the reader navigated, and the _Plan is in {identifier} · Go there_ offer) is replaced by _follow
> while on; the person's navigation turns following off; Follow the planner asks again_. The FOLLOW-MOVE's
> transition, reduced-motion form and announcement below are REUSED unchanged by every driven move.
> Outside `generating` this section stands as written.

**Asset:** `planning-workspace--arrival.mock.html` — a **DELTA**, eight panels, holding only what
changes.
**Story:** MOTIR-6154 — _the planning surface OPENS INSIDE the node being planned_.

### What this amends, by path

| amended                                                                                 | how                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/ai-chat/planning-workspace.mock.html` (sheet 6)                                 | the canvas pane's ARRIVAL LEVEL and its breadcrumb. The frame, scrim, `grid-cols-[1fr_22rem]` split, exit chrome, audit slot and footer slot are INHERITED and not redrawn                                                                                                    |
| this file, § _⚠️ Opening & exiting — a full-screen overlay ON TOP of the app (sheet 6)_ | its _Every state_ table gains nothing; its ADDRESS table gains nothing. Only where the canvas STANDS changes                                                                                                                                                                  |
| `components/planning/PlanningWorkspaceOverlay.tsx`, the **ANCHOR READ** block           | **SUPERSEDED.** Its comment reads _"ANCESTORS ONLY (MOTIR-2070): … Opening on the anchor's CHILDREN would hide the item the conversation is about."_ The requester has overturned it, and §_The answer to MOTIR-2070_ below is how the objection is met rather than dismissed |

### 0. What was RENDERED first, and what it settled

Per the design-against-shipped-reality rule. The **real `ProjectRoadmapCanvas`** was mounted at
`origin/main` `d0976c0ab` through the shipped `renderWithIntl` harness, in happy-dom, and its
breadcrumb `outerHTML` dumped per case. Nothing here is read off this delta's own stylesheet.

| what was rendered                                                          | what it settled                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialTrail={[]}`                                                        | the root level, and **NO breadcrumb node at all** — the canvas renders one only when drilled. So at the root there is nothing to name a target in, which is why panel 5's affordance brings the bar with it            |
| `initialTrail={[E1]}` (today's story anchor)                               | level = the story's SIBLINGS; crumb `Roadmap › MOTIR-1 · Epic one`, the epic `aria-current="page"`                                                                                                                     |
| `initialTrail={[E1,S1]}` (this design)                                     | level = the story's CHILDREN; crumb `Roadmap › MOTIR-1 · Epic one › MOTIR-2 · Story one`, the **story** `aria-current="page"`, `font-semibold text-(--el-text)`. **The arrival this story asks for needs no new prop** |
| `controlledTrail` moved `[] → [E1]` on a MOUNTED canvas                    | the level moves with **no remount**, and a re-render with the same value is a true no-op. This is the follow-move's seam, and it already exists (MOTIR-3835)                                                           |
| `controlledTrail` **held** at `[]` while the reader drilled                | the drill was **UNDONE within 150ms** — nodes back at the root, breadcrumb gone. ⚠️ A held controlled trail PINS the canvas                                                                                            |
| `controlledTrail` + `onLevelChange` syncing it (the `RoadmapView` pattern) | the reader drills normally. **This is the composition the follow-move must use**                                                                                                                                       |
| `controlledTrail` + `resolveHeldNode` with an id the resolver remaps       | **`Error: Too many re-renders. React limits the number of renders to prevent an infinite loop.`** The prop's own _"not combinable"_ warning is a crash, not a caution — see flag 1                                     |

### The RULE — one sentence, three entrances

**The canvas's arrival trail is `ancestors ++ [target]` when the target may have children, and
`ancestors` when it cannot.** The last crumb is the level the canvas loads, which is the shipped
`initialTrail` contract; nothing else changes.

| target kind                       | trail                       | the target is marked by                          |
| --------------------------------- | --------------------------- | ------------------------------------------------ |
| `epic` · `story` · `task` · `bug` | **`ancestors ++ [target]`** | the TARGET CRUMB (below)                         |
| `subtask`                         | **`ancestors`**             | the shipped node RING + `Target` pill, unchanged |
| none / unresolvable               | `[]` — the root, silently   | nothing                                          |

**The discriminator is the KIND the anchor read already returns, and it needs no second read.**
`lib/issues/parentRules.ts` is the single source of truth for the kind matrix and it makes
`subtask → []` — the one structural leaf; every other kind may parent. So "has an inside" is a
property of the kind, answerable from `PlanningAnchor.anchor.kind`, which
`GET /api/work-items/planning-anchor` already returns. **A container that happens to be empty still
opens inside it**: that is where the plan's cards are about to land, and the canvas's own
`roadmap.canvas.emptyDrilled` statement already says "No items at this level" (panel 7).

**This rule is not new to the codebase — it is the ROADMAP's, hoisted.**
`app/(authed)/roadmap/page.tsx`'s `resolveArrivalTrail` already builds `[...ancestors, item]` from
this same route, and its comment names the surface it is deliberately deeper than:
_"Deliberately one crumb deeper than the planning overlay's own `planItem=` anchor, which opens on
the anchor's OWN level so the anchor is visible; the two surfaces want different things and keep the
same param name."_ **That sentence is what this story retires**: the two surfaces now want the same
thing. The anchor route's own body comment already anticipates both readings — _"the workspace opens
on the anchor's OWN level (ancestors only); the roadmap opens INSIDE the item (ancestors plus the
item). One body serves both."_

**⚠️ AND THE ROADMAP'S VERSION CARRIES A FOLDER CHAIN THIS ONE MUST TOO.** `resolveArrivalTrail`
prepends the item's placement-folder crumbs, because a filed item sits behind its folder's door and
a trail without them is a level the reader could not have reached by hand. The planning canvases
draw folder levels (Part XVIII of `design/ai-planning/design-notes.md`), and `PlanChangeCanvas`
already imports `folderIdFromNodeId` and `FolderEmptyLevel` — so **a filed target's arrival trail is
`folderChain ++ ancestors ++ [target]`**, with the shipped folder-crumb treatment
(`isFolderCrumb`, the `Folder:` prefix, the >3 run collapse) untouched. The card did not name this;
it falls out of hoisting the rule rather than re-deriving it.

### The answer to MOTIR-2070 — the target stays NAMED, as the level you stand in

MOTIR-2070's objection is correct and this design does not wave it away: standing inside the item
removes the node the ring was drawn on. The answer is to move the mark to where the target now IS —
the last crumb — rather than to keep the reader outside.

**It reuses a seam the breadcrumb already has.** The FOLDER crumb (bug MOTIR-5710 · MOTIR-5742)
established that a crumb may be led by a 14px lucide glyph and carry a visually-hidden prefix: the
`folder` and `srPrefix` props on the canvas's own `Crumb`. The TARGET crumb is a **second crumb
kind** through that same seam — no new shape, no new primitive.

| element              | token / primitive                                                       | why                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| glyph                | lucide `target`, 14px (`size-3.5`), `--el-accent-on-surface`            | the same mark `PlanningTargetFrame`'s pill carries, so "target" means one thing on this surface whether it is a node or the level |
| underline            | `inset 0 -2px 0 0 var(--el-accent)`                                     | 2px matches the node ring's weight, which is what makes the two read as one state; it marks without tinting the label             |
| label                | `--el-text`, `font-semibold`, `max-w-[18rem] truncate` + native `title` | the shipped active-crumb pair, unchanged, including the ellipsis-the-last-crumb rule                                              |
| screen-reader prefix | `sr-only` `"Planning target: "`                                         | NOT COLOUR ALONE — the discipline the node pill already states, through the prop that already exists                              |

**The glyph and the underline never truncate**, which is why the mark is a glyph rather than a
longer word: at 420px the label ellipsises and the state survives (panel 7b).

### The FOLLOW-MOVE

Fires **once**, when a target first becomes known: the person adds one to the composer's target set,
or the plan's proposals first show where the plan lands. The composition is the shipped one.

| axis           | specification                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seam           | `controlledTrail` (MOTIR-3835) — it adopts DURING RENDER, clears exactly what a drill clears, suppresses auto-descend for the adopted level, and does **not** remount, so the level cache, the canvas chrome and the breadcrumb machinery survive                                                                             |
| composition    | **the `RoadmapView` pattern**: the host HOLDS the level, seeds it from the arrival trail, and follows the reader through `onLevelChange`. ⚠️ A `controlledTrail` held at a fixed value PINS the canvas — measured: a drill is undone within 150ms — so the sync is not optional polish, it is what keeps the canvas navigable |
| transition     | a **180ms opacity crossfade** on the level, built from this canvas's own vocabulary — `transition-opacity motion-reduce:transition-none`, the exact idiom `ProjectRoadmapCanvas` already uses for its emphasis layer. The breadcrumb appends without animation. No slide, no zoom: the canvas already resets scale per level  |
| reduced motion | `motion-reduce:transition-none` — the move is INSTANT and nothing else changes. The announcement still fires, because it carries the meaning                                                                                                                                                                                  |
| announcement   | a polite live region in the canvas pane — the `aria-live="polite"` idiom this surface already uses (`PlanChangeRail`, `PlanningHandOff`). One sentence, once per move                                                                                                                                                         |

### The person who NAVIGATED FIRST

**A deliberate navigation is never overridden.** `RoadmapView` already reasons this out for the same
canvas — _"A stale URL and a genuine Back are indistinguishable from the params alone — they differ
only in the EVENT — so this listens for the event"_ — and the same holds here: the host disarms the
follow-move on the first `onLevelChange`, not on a comparison.

Saying nothing would strand them, so the breadcrumb bar gains the **one new control in this design**:
a quiet affordance on the bar's own row, pushed right, reading **"Plan is in {identifier} · Go
there"**. `--el-card` on `--el-border`, label `--el-text-secondary`, a 6px `--el-accent` dot.
Clicking it performs the move as if it were the follow-move — same crossfade, same announcement —
and it then disappears, reappearing only if they navigate away again while the target still differs.
**Not a toast, not a modal, no auto-dismiss timer, and it never moves the canvas by itself.** At the
root there is no bar, so the affordance brings one: the bar renders with the root crumb alone.

### SEVERAL targets

Inside the **first** (MOTIR-6014). The composer's target tray already lists the others, so nothing
new is drawn for them: the first target's chip takes the same `--el-accent` ring the crumb's glyph
carries, so _which one am I standing in_ is answerable from either pane, and a chip click moves the
canvas exactly as the affordance does.

### Copy — `messages/en.json` and `messages/zh.json`

Three new keys, all under the existing `planningWorkspace` namespace.

| key                                           | `en`                                 | `zh`                         |
| --------------------------------------------- | ------------------------------------ | ---------------------------- |
| `planningWorkspace.arrival.crumbTargetPrefix` | `Planning target: `                  | `规划目标：`                 |
| `planningWorkspace.arrival.movedAnnouncement` | `Showing work inside {target}`       | `正在显示 {target} 内的工作` |
| `planningWorkspace.arrival.goToTarget`        | `Plan is in {identifier} · Go there` | `方案在 {identifier} · 前往` |

Every other string on these panels is already in the catalogue and is **reused, not re-keyed**:
`roadmap.canvas.breadcrumbRoot`, `roadmap.canvas.back`, `roadmap.canvas.emptyDrilled`,
`planningWorkspace.targets.nodePill`, `planningWorkspace.close`, `planningWorkspace.canvasAria`.

### The ACCESS PATH — five entrances, one rule

| entrance                                       | what the address carries                                                              | where the canvas arrives                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Plan with AI** on a work item                | `planFrom=work-item` + `planItem=<key>`                                               | inside that item; or its own level, ringed, for a `subtask`                 |
| a **Plans** row                                | `planSession=<id>` + `planVia=plans`, with `planItem=` when that session has a target | the same arrival as Plan with AI for that target                            |
| a **To approve** row                           | `planSession=<id>` + `planVia=approvals`, with `planItem=` when the plan has a target | the same arrival — a plan you are asked to decide opens where its cards are |
| **⌘K** / global launcher                       | `planFrom=project`, no item                                                           | the root, then the follow-move                                              |
| the **project launcher** / roadmap empty state | `planFrom=project` or `roadmap`, no item                                              | the root, then the follow-move                                              |

**No new address parameter.** The To-approve row already writes `planItem=` when its plan has a
target — MOTIR-6033's design, `design/ai-planning/design-notes.md` Part XXII § _22.2 The ACCESS
PATH_ — so all three targeted entrances hand the arrival rule the same key. That is what makes "one
arrival rule" a fact rather than an aspiration. (When this was written that design was **published
only**, so this sentence cited it by card key; MOTIR-6190 has since landed it as Part XXII — see
flag 3.)

### What is INHERITED and not redrawn

Sheet 6's `Modal size="full"` frame edge to edge (0px radius, 0px border), the scrim, the
`grid-cols-[1fr_22rem]` canvas·rail split, the host's own exit-chrome bar, the four exits, the
close-with-pending guard, the audit-banner slot and the footer slot. From
`design/ai-planning/design-notes.md`: **Part IX**'s `arrivalLevel()` — _the level the plan most
fills_ — which is the plan page's own rule and is **reused, not re-cut**; it is what answers "where
do the proposals land" for the follow-move's second trigger. Part V is the plan-review DETAIL
surface and is NOT this asset's reference (see flag 3).

### Primitives composed (no hand-rolling)

`ProjectRoadmapCanvas`'s breadcrumb `nav` / `ol` / `Crumb` / Back control, `PlanChangeCanvas`,
`PlanningTargetFrame`'s ring + pill, the level skeleton, `roadmap.canvas.emptyDrilled`. **The only
new elements are a crumb KIND and the go-there affordance**, and both are compositions of existing
tokens rather than new primitives.

### GIVES / TAKES

| card                                                   | GIVES / TAKES                    | what                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-6160 — the canvas OPENS INSIDE its target        | **GIVES · STRUCTURE**            | the arrival rule and its kind discriminator; the folder-chain limb; the target crumb; that the trail is `initialTrail` and needs no new prop. **Hoist `resolveArrivalTrail`'s logic rather than writing a second copy**                            |
| MOTIR-6161 — the canvas FOLLOWS a newly settled target | **GIVES · STRUCTURE + a HAZARD** | the `controlledTrail` seam, the `onLevelChange` sync that keeps the canvas navigable, the crossfade + reduced-motion + announcement, the disarm-on-navigate rule, the go-there affordance — **and flag 1, which is a crash it must design around** |
| MOTIR-6162 / MOTIR-6163 — the test cards               | **GIVES · PREMISE**              | the five entrances, the leaf/container split, the follow-once-never-after-navigation seam, and the measured behaviours in §0 as the assertions' shape                                                                                              |
| MOTIR-6033 — the decide surface                        | **TAKES · PREMISE**              | that a To-approve row carries `planItem=` when its plan has a target. Nothing here changes it                                                                                                                                                      |
| MOTIR-2070                                             | **TAKES · SUPERSEDED**           | its own-level rule, overturned above. The card stays `done`: it is the record of what was decided then                                                                                                                                             |

### ⚠️ Planning flags — what contradicts shipped code

1. **`controlledTrail` and `resolveHeldNode` are not combinable, and the planning surface's canvas
   passes the second one.** `PlanChangeCanvas` supplies `resolveHeldNode` because approving a plan
   re-keys every proposal to the work item it became. The prop doc says the two _"would fight over
   `focusId`"_; the render in §0 shows the fight is **`Too many re-renders`**, an outright crash,
   when the host's controlled trail holds an id the resolver remaps. **The rule for MOTIR-6161:**
   the host's trail must live in the **committed** id space — the space `resolveHeldNode` resolves
   TO — and never carry a proposed node id. Measured: with the two agreeing, the canvas settles
   normally. This is a design constraint on the follow-move, not a defect to fix in the canvas.
2. **The cards point at the canvas under a `roadmap` directory, and there is no such directory
   under `components/`.** MOTIR-6154's and MOTIR-6159's Context refs name it there; the component is
   at
   **`components/planning/ProjectRoadmapCanvas.tsx`**. Verified with `git ls-tree` on `origin/main`
   — a path typo in the cards, not a missing prerequisite. (The bad path is described rather than
   quoted here, because `tests/design-asset-addresses.test.ts` rules on every repo path an asset
   names, and it is right to.) The same refs say a follow-move _"needs this seam"_; **the seam
   already shipped** as `controlledTrail` (MOTIR-3835).
3. **`design/ai-planning/design-notes.md` Part XX is NOT the decide surface.** This file's ADDRESS
   table cites _"`design/ai-planning/design-notes.md` Part XX §20.2"_ for `planVia`. In the
   repository that number now resolves to **MOTIR-6134's difficulty section** (merged 2026-09-24
   08:30, PR #3082); MOTIR-6033's Part XX was published as a design result and never committed, so
   the citation resolves to the wrong section. Filed as its own bug; this section cites MOTIR-6033
   by card key for that reason.
   **RESOLVED (MOTIR-6192).** MOTIR-6190 has since landed MOTIR-6033's design as **Part XXII**
   (its §20.N is §22.N there), so the ADDRESS row now cites Part XXII §22.2. The rule for citing a
   design that is published but not landed is stated once, under the index table of
   `design/ai-planning/design-notes.md`.

4. **The PROPOSAL card is a second drawing of the committed card, not a layer over it.** Rendered
   side by side (the table in § _ONE CARD, THREE SURFACES_): the shell agrees on footprint, radius,
   border weight and shadow, and differs on **padding** (`p-3.5` vs `p-3`), on a **`KIND_TINT`
   declared twice**, and on a **state vocabulary `PlanItemNode` cannot express at all** (ready /
   done / here / not-in-sprint / cross-blocked). Filed as MOTIR-6196; it is not this story's work.

### ⭐ ONE CARD, THREE SURFACES (panel 9 — AMENDED 2026-09-24, on review)

**Requested on review:** the card must look the same in the roadmap, on the planning surface, and
after the plan is proposed. **It very nearly does, and the places it does not are drift rather than
decisions** — measured by rendering the two real card components for the same work item through the
shipped `renderWithIntl` harness and diffing their shells, the same method §0 uses.

| shell property                  | committed card (`WorkItemNode`)                         | proposal card (`PlanItemNode`)              | verdict                   |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------- | ------------------------- |
| footprint                       | **280 × 124** (`NODE_W` / `NODE_H`)                     | identical                                   | **one**                   |
| radius · border weight · shadow | `rounded-(--radius-card) border shadow-(--shadow-card)` | identical                                   | **one**                   |
| **padding**                     | `p-3.5` — 14px                                          | `p-3` — 12px                                | **DRIFT**                 |
| kind tint map                   | `KIND_TINT`                                             | `KIND_TINT` **declared again, identically** | **DRIFT**                 |
| border style · colour · fill    | `--el-border` / `--el-surface`                          | dashed `--el-accent` / `--el-tint-lavender` | **KEEP** — this IS the op |
| state vocabulary                | ready · done · here · not-in-sprint · cross-blocked     | **none of them**                            | **GAP**                   |

**THE RULE.** There is ONE card shell — footprint, radius, border weight, padding, shadow, and the
kind bar · identifier · title · status row — and it has ONE implementation. A proposal's op
treatment, the target ring and the plan-change diff frame are **LAYERS OVER that shell, never second
drawings of it.**

**Two of the three layers already work exactly this way, and say so in their own source.**
`PlanningTargetNode`: _"It WRAPS the shipped node — the same compose-don't-redraw seam
`PlanChangeDiffFrame` uses … The work item keeps rendering as the real `WorkItemNode`; this adds a
ring, a glow and a word on top."_ **The op layer is the one that does not**: `PlanItemNode` imports
three sub-pieces from `WorkItemNode` (`WorkItemStatusPill`, `CrossBlockedFlag`, `GhostAnchor`) and
then re-draws the card body around them, which is how a second `KIND_TINT` and a second padding got
there. Its own header already states the intent — _"It draws the SAME compact card language as the
shipped `WorkItemNode`"_ — so this is drift from a stated rule, not a disagreement about it.

**What follows for THIS story, which is the part that binds MOTIR-6160 and MOTIR-6161.** Surfaces 1
and 2 already draw the **identical component**: a committed card on the planning surface is the same
`WorkItemNode` the roadmap draws, because both levels are built by `buildWorkItemLevel`. So _"the
same in the roadmap and on the planning surface"_ is **true today**, and the constraint this design
places on the arrival work is that it must stay true: **changing where the canvas STANDS may not
change what a card LOOKS like.** Neither the arrival trail nor the follow-move touches a node
renderer, so meeting this costs nothing — it is a thing not to break.

**And the third surface's three differences are NOT this story's work.** They touch no arrival and no
follow-move, and absorbing them would put a card-renderer refactor inside a story about which level
the canvas opens on. They are filed as their own card — MOTIR-6196, flag 4 below — rather than deferred in prose.

### Deliverable

`design/ai-chat/planning-workspace--arrival.mock.html` (NINE panels, light + dark, narrow) · this
section. **A DELTA, per `CLAUDE.md`'s rule** — the base sheet is not edited, and there is no `.png`
(AMENDMENT 4 retired the export). Published as MOTIR-6159's design result, which is what
MOTIR-6160 and MOTIR-6161 are `blocked_by`.

---

## ⭐ The MULTI-LINE planning composer — growth to its cap, and the line-broken user bubble (MOTIR-6236, 2026-09-24)

**Asset:** `design/ai-chat/planning-workspace--multiline-composer.mock.html` — a **DELTA**, thirteen
sheets, light and dark, **at a 480px conversation pane** (panels 1–11) and **at the 352px floor**
(panel 12). It amends `planning-workspace.mock.html`
(MOTIR-1193), `target-picker.mock.html` (MOTIR-1490), `plan-change-planner-speaks.mock.html`
(MOTIR-2225), `plan-change-run-live.mock.html` (MOTIR-4066) and
`design/ai-planning/plan-revision.mock.html` (MOTIR-3597). **Those five are records of their own
moment and are not edited.**

**Story MOTIR-6156.** The composer is one component — `components/planning/PlanChangeComposer.tsx` —
with two hosts: the planning surface's rail (`PlanChangeRail.tsx:710`) and the plan page's revise box
(`PlanReviewRail.tsx:415`, `mentions={false}`). It ships as a single-line `<input type="text">`. It
becomes a **multi-line field that grows with its content to a cap, then scrolls inside itself**.

### ⚠️ REDRAWN AT THE SPLIT'S WIDTH — what changed, and what did not

**The first version of this asset drew every panel at the rail's then-fixed `22rem`, and its design
gate was answered REQUEST CHANGES for exactly that:** _"the right conversation window is too narrow,
so the textarea is too narrow too."_ The width is not this card's to choose. It is **MOTIR-6249**'s
approved resizable split, and the numbers are shipped in `lib/planning/railWidth.ts` — whose own
header says every one of them is a decision of that design result, which this asset therefore READS
rather than re-derives:

| shipped constant            | value  | what it means here                                |
| --------------------------- | ------ | ------------------------------------------------- |
| `RAIL_MIN_PX`               | `352`  | the floor — panel 12's width                      |
| `RAIL_DEFAULT_FRACTION`     | `1/3`  | the conversation's share of the split container   |
| `RAIL_MAX_FRACTION`         | `0.5`  | the drag ceiling — 720px at a 1440 container      |
| `RAIL_DEFAULT_CROSSOVER_PX` | `1056` | below it a third is under the floor and it clamps |
| `SPLIT_MIN_CONTAINER_PX`    | `768`  | below it there is no split at all                 |

`defaultRailWidth(1440)` = `clamp(352, 480, 720)` = **480px**, canvas 960px. That is what panels 1–11
are drawn at, and the board reads it from one `--rail-w` token so no panel can disagree with another.

**The floor is not an edge case.** Below the 1056px crossover the default clamps to 352px, so every
split container between 768px and 1056px opens at exactly the width the rejected first version was
drawn at. Panel 12 is that width, and **its boards are the first version's markup re-used rather than
re-drawn** — 352px stopped being the DEFAULT, not a real width.

**The plan page's revise box is not a split host** and keeps its own width; measured, its 378px
default behaves like the 480px one, not like the floor.

### What the WIDTH actually changed — measured, not asserted

Read back out of a headless Chromium render of the committed board (1440×1000, dSF 1) by overriding
`--rail-w` and re-measuring, rather than computed from the tokens:

| rail pane           | field | target tray    | the same 3-line message |
| ------------------- | ----- | -------------- | ----------------------- |
| **352px** (floor)   | 302px | 79px / 3 lines | **4 rows**              |
| 378px (plan page)   | 328px | 58px / 2 lines | 3 rows                  |
| **480px** (default) | 430px | 58px / 2 lines | **3 rows**              |
| 720px (ceiling)     | 670px | 26px / 1 line  | 3 rows                  |

Two findings follow, and neither is visible in the markup:

- **The same typed message costs a FOURTH row at the floor.** Panel 12's grown board is therefore
  drawn at 104px (4 rows), not at the 84px the 480px board uses. Re-using the 84px board there would
  have clipped its own content under `overflow-y: hidden` — silently, with no scrollbar, because a
  mock's height is an inline number and not the auto-grow the code will do.
- **The target tray is the one footer element whose height the split really changes** (three lines at
  the floor, two at the default, one at the ceiling), which is why it is the term that moves in the
  worst-case footer below.

### How the asset was made, and which fragments carry which warranty

Every **composer** fragment is the REAL emitted markup of the shipped component, captured from a
headless render through the repo's own `tests/helpers/renderWithIntl` harness → `container.innerHTML`,
in eight states. **Exactly one node is changed in each: the `<input>` becomes a `<textarea>`.** The
**user-bubble** and **rail-header** fragments are NOT renders — their class strings are copied
byte-for-byte from `PlanChangeRail.tsx`'s `Bubble` (`:1124-1152`) and from
`plan-change-run-live.mock.html`, which is a render of that rail. The stylesheet is Tailwind's
compiled output, lifted verbatim from that same asset.

**Four things the render corrected that reading the `.tsx` did not:**

1. **Send is a SIBLING of the field**, not a child — one `flex items-center gap-2` row. So growth
   moves Send unless the row is re-aligned, which is why alignment is a decision this card owes.
2. **The `@` trigger is `position: absolute; left: 1.5`** inside that centring row, so it drifts to
   the vertical middle of a grown field with no class of its own changing.
3. **The user bubble has NO whitespace handling and no `min-w-0`.** `{turn.body}` is a bare text
   child of a `<div>`, so **a multi-line message collapses to one run-on line today.**
4. **A textarea does not vertically centre one line the way an `<input>` does.** Reproducing the
   shipped 44px at one row is therefore arithmetic, not a token — see below.

### The measurements, and the four decisions

**Height.** `--height-input` (44px) at one row, **+ one `line-height` (20px) per further row**:
44 / 64 / 84 / … / **184 at the cap**. The vertical padding that makes one row _exactly_ the shipped
44px is derived rather than taken from a token —
`(--height-input − line-height − 2 × border) ÷ 2` = `(44 − 20 − 2) ÷ 2` = **11px**. Using
`--spacing-input-y` (12px) instead makes the at-rest field **46px**, which is a visible 2px growth on
a composer nobody has typed into. **The code reads line-height, padding and border from the computed
style and clamps** (MOTIR-6237's own contract), so the clamp stays exact under every type scale and
density; the numbers here are those tokens' current values, not constants to hard-code.

1. **THE CAP IS 8 ROWS (184px) — unchanged by the split, and re-measured at it.** This confirms the
   story's assumption. **The cap is a VERTICAL budget and the split changed WIDTH, so the number does
   not move**; what moves is the worst case around it. Re-measured on the rendered board, the
   worst-case footer — cap **plus** target tray **plus** running bar — is:

   | pane width      | cap | tray (+8px gap) | running bar (+8px) | worst-case footer |
   | --------------- | --- | --------------- | ------------------ | ----------------- |
   | 352px (floor)   | 184 | 87              | 56                 | **327px**         |
   | 480px (default) | 184 | 66              | 56                 | **306px**         |
   | 720px (ceiling) | 184 | 34              | 56                 | **274px**         |

   At 480px on a 900px-tall viewport that leaves the transcript ~525px — the majority of the rail,
   which is the argument the eight rows were chosen on, now checked at the width the composer
   actually ships at. At ten rows the 480px stack is ~346px and the transcript drops toward half on a
   shorter viewport. **Eight is still the last row count at which the transcript stays the larger
   region in the worst case, and it is now the last count at the FLOOR too** (327px), which is the
   binding case rather than the default. The revise box takes the same cap.

   ⚠️ **The earlier figure in this section was `24 + 34 + 56 + 184 ≈ 298px`, and it under-counted the
   tray** — it used a one-line tray (34px), which the render only produces at the 720px ceiling. The
   numbers above replace it.

   **A wider field does not mean a taller one.** It means the same paragraph reaches the cap LATER:
   measured, the sample message is 3 rows at 480px and 4 at 352px.

2. **`@` AND SEND ALIGN TO THE BOTTOM** — `items-end` on the control row, `bottom-1.5` on the
   trigger. Centre-aligning walks both controls down the field as it grows, so the target a person is
   aiming at moves while they type; bottom-aligning holds them a fixed distance from the caret's last
   line. It is also where MUI X's chat composer puts its send control, in a toolbar below the field.
   **The price, stated rather than buried: at rest the row is 44px and Send is 32px, so
   bottom-aligning drops Send 6px lower than today's centring.** That 6px is the only visible change
   to the untouched composer, and it buys a control that never moves again from one row to eight.
3. **NO PERSISTENT KEYBOARD HINT**, and **no message key is owed** in either locale. Checked against
   two references. **MUI X's Chat Composer** documents the behaviour — _"submits on Enter and inserts
   a newline on Shift+Enter"_ — and its published component anatomy carries no hint element; the
   behaviour is implicit. **Slack** documents _"Create a new line: Shift Enter"_ in its **help
   centre**, not as composer chrome. At `22rem` a permanent hint line costs ~18px of the one region
   that never scrolls, forever, to teach a convention both references treat as already known.
   _(Both checks are of published documentation, not of a rendered screenshot — said plainly so the
   next reader knows what was and was not verified.)_
4. **THE MANUAL RESIZE HANDLE IS GONE** — `resize-none`, replacing the primitive's `resize-y`. The
   two fight: a hand-dragged height is overwritten by the next keystroke's measurement.

### The bubble

`whitespace-pre-wrap` so the typed newlines survive, plus **`wrap-anywhere` and `min-w-0`** so a long
unbroken token (a URL, a key) breaks inside the bubble instead of widening it past the rail.
`wrap-anywhere` is the class the shipped rail already uses for exactly this on the revision-held line
(`PlanReviewRail.tsx:398`), so this is the surface's own treatment rather than a new one.
**Assistant bubbles are unchanged** — they render Markdown through `MarkdownView`, which blocks its
own paragraphs. Only the user bubble renders raw typed text.

### The sheets, and which shipped card owns the behaviour each draws

| #   | State                                                           | Width  | Behaviour owned by                                  |
| --- | --------------------------------------------------------------- | ------ | --------------------------------------------------- |
| 1   | At rest — byte-identical to today                               | 480px  | MOTIR-1193 (the rail), MOTIR-1491 (the `@` trigger) |
| 2   | Grown to three rows; the transcript shrinks and scrolls         | 480px  | this card                                           |
| 3   | At the cap; a ten-line paste scrolls inside the field           | 480px  | this card                                           |
| 4   | Grown, with the target tray                                     | 480px  | MOTIR-1491                                          |
| 5   | Grown, with the answer bar; Send reads **Answer**               | 480px  | MOTIR-2226                                          |
| 6   | Grown, with the running bar and **Stop**; a queued mid-run turn | 480px  | MOTIR-4068, MOTIR-4274                              |
| 7   | Disabled while grown; the draft AND its height are kept         | 480px  | MOTIR-6033 §20.5                                    |
| 8   | A pre-filled multi-line draft, sized on first paint             | 480px  | MOTIR-6210 (a later consumer)                       |
| 9   | The user bubble keeps its line breaks                           | 480px  | this card                                           |
| 10  | A long unbroken token wraps inside the bubble                   | 480px  | this card                                           |
| 11  | The plan page's revise box, at rest and grown                   | 378px¹ | MOTIR-3601                                          |
| 12  | **At the conversation's MINIMUM width** — rest, grown, capped   | 352px  | MOTIR-6249 (the floor), this card (the composer)    |
| 13  | The decisions, the anatomy, and what is unchanged               | —      | —                                                   |

¹ The revise box is not a split host, so it is drawn at its own pane width rather than at the split's
default. The board renders it in the same 480px column as its siblings; the 378px figure is the plan
page's measured container-derived default, and the composer's behaviour is identical at both.

**Access path — UNCHANGED, and drawn so.** The rail composer is reached through the planning surface
(the Plan-with-AI entrance, MOTIR-910 / MOTIR-1193); the revise box on a plan's page (MOTIR-3601).
Every state is drawn **inside its host frame**, not as a floating field, so the entry context is
visible. This card adds no new door.

### Primitives and tokens

The shared **`Textarea`** (MOTIR-6237 gives it `autoGrow` + `maxRows`), **`Button`**
(`primary`/`secondary`, `sm`), **`Spinner`**, **`PlanningTargetChip`**, **`BrandMark`**. Nothing is
hand-rolled. Shape flows through `--radius-input|card|control|badge|btn`, `--spacing-input-x|y`,
`--spacing-chip-x|y`, `--height-input`, `--height-btn-sm`; colour through the `--el-*` element layer
only.

> **⚠️ A NOTE FOR WHOEVER LIFTS THIS STYLESHEET NEXT.** Tailwind v4 **tree-shakes `@theme`
> variables** — it emits only the ones a compiled utility actually references. The sheet lifted from
> `plan-change-run-live.mock.html` was built for a board that never used `py-(--spacing-input-y)`, so
> **that token was absent from `:root` and the rule silently computed to `0`**. A lifted stylesheet
> carries the tokens of the asset it came from, not the whole theme. This was caught only by
> RENDERING the board and measuring the box; it is invisible in the markup.
>
> **⚠️ AND THE REDRAW FOUND ONE MORE, INHERITED FROM THE FIRST VERSION: `--focus-ring-color`.** It is
> referenced **74 times** on this board — every `focus-visible:ring-` on the field, the `@` trigger,
> Send and Stop — and the lifted sheet never defined it, so all 74 focus rings computed to nothing in
> both themes. It is now declared in the board's supplementary `:root`, verbatim from
> `packages/design-system/theme.css:262` (`var(--color-primary)`, whose referent the lifted sheet does
> carry). Same hazard as `--spacing-input-y` above, one token further on — and the reason this section
> says to RENDER rather than to read.
>
> **The remaining undefined references were checked and are dead**, not a third instance:
> `--tilt-*`, `--font-*-source` and `--default-font-*-settings` are named only by rules the lifted
> sheet brought with it that **no element on this board matches** (the board's markup mentions none of
> them). They are left undeclared rather than padded in, so the sheet stays lifted verbatim and the
> `:root` block holds only tokens this board actually resolves.

### GIVES / TAKES — every key the asset names

**GIVES** — **MOTIR-6238** (the composer card): the cap, the height arithmetic, the bottom alignment,
the `whitespace-pre-wrap` + `wrap-anywhere` + `min-w-0` bubble, and the no-hint decision (so it owes
no new string). **MOTIR-6237** (the primitive): the one-row-equals-`--height-input` contract, the
per-row increment, and `resize-none`. **MOTIR-6210**: sheet 8's pre-filled shape.

**GIVES, added by the redraw** — **MOTIR-6238** also gets **the two widths to build and test at**:
480px, and the 352px floor that every split container under the 1056px crossover opens at.
**MOTIR-6239** and **MOTIR-6240** get that floor as a second width their integration seams and their
E2E walk are exercised at, which panel 12 is the drawing of.

**CONSUMED, not amended** — **MOTIR-6249** and **MOTIR-6250**. This asset reads their settled numbers
out of `lib/planning/railWidth.ts` and chooses none of them. The edge is carried at the STORY level
(MOTIR-6156 `blocked_by` MOTIR-6248), because a `blocked_by` runs between siblings under one parent.

**TAKES — nothing, from any card.** No criterion on MOTIR-6237, MOTIR-6238, MOTIR-6239, MOTIR-6240,
MOTIR-6206, MOTIR-6210, MOTIR-6249 or MOTIR-6250 is contradicted or removed: the cap this asset
settles is the number those cards already say they read from it, it is **unchanged** by the redraw, and
the story's own eight-line assumption is confirmed rather than corrected. **No amendment to any card is
owed by this PR.**

**The one correction the redraw makes is to THIS ASSET'S OWN first version**, not to a card, and both
are recorded above rather than quietly overwritten: the target tray's _"three or more chips at 22rem"_
threshold (falsified by the render — two chips already wrap at 480px) and the worst-case footer's
`≈298px` (which under-counted the tray).

Referenced for provenance only, unchanged by this asset: MOTIR-1193, MOTIR-1490, MOTIR-1491,
MOTIR-2225, MOTIR-2226, MOTIR-3597, MOTIR-3601, MOTIR-4066, MOTIR-4068, MOTIR-4274, MOTIR-6033,
MOTIR-6156, MOTIR-6010. `MOTIR-812` / `MOTIR-918` are the repo's own composer test fixtures, used as
sample tray chips. `MOTIR-4944` appears inside the lifted stylesheet's own comment.

### Deliverable

`design/ai-chat/planning-workspace--multiline-composer.mock.html` (THIRTEEN sheets, light + dark;
panels 1–11 at the split's 480px default, panel 12 at its 352px floor) · this section · the AMENDMENT
pointer in `design/ai-planning/design-notes.md` Part XII. **A DELTA, per `CLAUDE.md`'s rule** — the five
base assets it amends are records of their own moment and are not edited, and there is no `.png`
(AMENDMENT 4 retired the export). Published as MOTIR-6236's design result, which is what MOTIR-6238 is
`blocked_by`.

## ⭐ The SEEDED re-plan — a refusal OFFERS the planner, with the first turn written and unsent (MOTIR-6206, 2026-09-25)

**Asset:** `design/ai-chat/planning-workspace--refusal-seed.mock.html` — a **DELTA**, ten sheets,
en + zh, light + dark, the conversation at MOTIR-6236's 480px (`defaultRailWidth(1440)`). It amends
`planning-workspace.mock.html` (the overlay, the rail and the composer) and MOTIR-6019's published
`ai-chat/planning-workspace--resume.mock.html` (the resumed state). **Neither is edited.** The
record band's door is drawn in `design/work-items/approval-control--replan-door.mock.html`, and the
Plans row in `design/ai-planning/plans-sessions--seeded.mock.html` (their own sections, in those
areas' notes).

**Story MOTIR-6068.** Contract: `docs/decisions/approval-gates.md` §10f and the three §10h rows for
`decision_approval` (Request changes), `decision_confirmation` (Overturn) and `decision_choice` (None
of these). Every one of them reads _"opens the planner: **always** — anchored on the decision/choice
card, seeded to re-plan from the reason"_.

Paths to published results that are not in this checkout are given relative to `design/` (for example `ai-chat/planning-workspace--resume.mock.html`). They are the results' `sourcePath`s and have not landed here.

**Composed from, not redrawn.** The stylesheet is lifted verbatim from MOTIR-6236's published
`design/ai-chat/planning-workspace--multiline-composer.mock.html`. The utilities that sheet never
needed are copied verbatim from MOTIR-6073's `work-items/approval-control--refusal-reason.mock.html`
and MOTIR-6019's `ai-planning/plans-sessions--list.mock.html`. The rail, the opener, the bubbles
and the composer mirror `components/planning/PlanChangeRail.tsx` and `PlanChangeComposer.tsx` class
for class. The loading frame is `components/planning/PlanningWorkspaceSkeleton.tsx` as it ships. The
confirm band in sheet 1 is MOTIR-6073's panel 2b. The decided band and its door are the
`approval-control--replan-door` delta's. `components/ui/*` primitives and `--el-*` tokens only.

### The sheets

1. **The hand-off, ASKING FIRST (amended 2026-09-25).** In the approval overlay: A, the refusal is
   pressed; B, it commits and the decided band ASKS, with nothing opened; C, yes (**Re-plan with AI**)
   does one `shallowReplace` from the approval address to the planning address, and the seeded planner
   rises; D, **Not now** or Esc leaves the overlay on the decided record, with focus on its door. On the
   item page: B′ is the same ask in place (en and zh); C′ is yes, the same planner over the item page;
   D′ is Not now, the decided record with its door, which is also where Close from the planner lands.
2. **`decision_approval` · Request changes**, seeded, en and zh.
3. **`decision_confirmation` · Overturn**, with three supersedes keys and with none, en and zh.
4. **`decision_choice` · None of these**, en and zh.
5. **A long reason** at the 8-row cap: as it opens (caret at the end, the tail showing) and scrolled up
   (the quote whole).
6. **Loading**: the whole-frame skeleton.
7. **Returning to the seeded session**: the resumed transcript, with no draft.
8. **The unseeded fall-back**: a plain project launch.
9. **Dark parity.**
10. **The first-turn contract** as a table, for all three kinds in both languages.

### The decisions

- **The planner does NOT open when the decision is recorded. The band ASKS first (amended
  2026-09-25).** The design gate came back CHANGES REQUESTED, and the reviewer's note, verbatim, is:
  _"Let the user confirm he wants to go to motir AI to replan the work item."_ After Request changes,
  Overturn or None of these commits, the just-decided band shows the ask in the place where the door
  will sit: _"Re-plan {key} with Motir AI?"_, two consequence lines, **Not now** and **Re-plan with
  AI**. That state is drawn once, in `design/work-items/approval-control--replan-door.mock.html`
  panel 0. Sheet 1 here shows the flow around it.
- **Why an inline ask and not a dialog.** `components/ui` has no confirm-dialog primitive; it has
  only `Modal`. The approval surfaces confirm with the inline band, and `ApprovalGateControl`'s
  `confirming` phase states the rule: _"an inline band over the verbs, never a modal"_. In the
  approval overlay, a dialog would stack a modal on a full-screen modal. The inline ask sits exactly
  where the door will sit, so declining only turns the question into the door.
- **Keyboard and focus.** When the ask appears, focus moves to **Re-plan with AI**, so Enter means
  yes. **Esc means Not now.** In the approval overlay, Esc inside the ask declines and does not also
  close the overlay. After Not now, focus goes to the **Re-plan with AI** door that replaces the ask.
  The ask is shown once, to the person who pressed the refusal, right after it commits. It is client
  state and is never stored, so a reload, another viewer or a later visit sees only the record and
  its door.
- **Yes is ONE address REPLACE, and the approval overlay is never left underneath.**
  `useOpenRefusalReplan().open(gateId)` (MOTIR-6211) does what `usePlanGateForward.ts` already does.
  It strips `approval` / `approvalKind`, writes `plan=replan&planFrom=refused-gate&planGate=<id>`,
  and replaces the history entry. The approval overlay's question has been answered, so there is
  nothing to go Back to. Close strips the planning params and lands on the host page, whose decided
  band carries the door. **The address carries the gate id and nothing else.** No reason text and no
  work-item title go in the URL (§10f). The door itself is a yes, so pressing it opens the planner
  directly, with no second ask.
- **The turn is in the COMPOSER, unsent.** The transcript is empty. The opener bubble is not a turn,
  and it reads _"Opened in the context of {item}."_ because the launch resolves to a `work-item`
  re-plan on `anchorKey`. The mode chip reads **plan change**. The field is focused, sized to its
  content (to the cap), with the caret at the END, so what shows first is the tail and the ask.
  **Send is enabled.** The person can send, edit or clear it. Nothing is billed and no session exists
  until they press Send.
- **No starter chips while the rail holds a seed.** A starter `setDraft`s its own text, so pressing
  one would silently throw the seed away. The seed is the start. If the person clears the field, the
  rail is an ordinary item re-plan again, placeholder included.
- **The placeholder.** `planningWorkspace.conversation.composerPlaceholderReplan` (_"What's wrong? What
  should change?"_ / _"哪里有问题？想怎么改？"_) is unchanged and still passed. The seeded turn takes its
  place as the field's CONTENT, so it is seen only after the draft is cleared. The turn's copy lives in
  `planningWorkspace.refusalSeed.*` (MOTIR-6208), composed on the server in the viewer's locale.
- **Loading is the anchor read's skeleton, extended.** The seed read
  (`GET /api/approval-gates/{id}/planning-seed`) runs first and the anchor read second, inside the one
  `PlanningWorkspaceSkeleton` window a `work-item` launch already shows. No live composer exists while
  the seed is read. The rail is a skeleton block with no text, so the empty re-plan placeholder
  cannot flash. The host then mounts once, with `initialDraft` already in its first render.
- **A long reason is quoted whole.** Line breaks are kept and nothing is clipped on the server. The
  field stops at MOTIR-6236's 8-row / 184px cap and scrolls inside itself.
- **Returning within the window is MOTIR-6019's RESUMED state.** The seed read's `seededSessionId`
  names the viewer's own recent seeded session, and the overlay opens that transcript. The first turn
  is the seeded text as sent, the composer is ordinary and empty, and **no draft is added** (a second
  seed would repeat the question). **The rail draws no "Reopened from the Plans page" line.** The
  conversation was resumed, not picked from a list (MOTIR-6019 panel 2).
- **The unseeded fall-back is silent.** An unknown, unreadable, foreign, not-refused or
  kind-without-composer gate, and any failure of the read, all open the overlay as a plain `project`
  launch: the **plan** chip, _"Opened on {project}."_, the starter chips, and the ordinary
  placeholder. There is no toast, no error, and no gate id or reason anywhere in the DOM. Saying "that
  refusal isn't available" would confirm to someone who cannot see it that the gate exists.
- **No close guard for an unsent seed.** The draft can be rebuilt by pressing the door again, so
  closing with it unsent discards nothing that cannot be had back. The shipped close guard still
  covers proposed work items only.

### The FIRST-TURN CONTRACT — what MOTIR-6208 composes

**The seed card MOTIR-6208 builds this contract, and the drawn text above is exactly its output.** The
turn is composed on the server from the decided gate row, in the request's locale, as **five parts in
this order, joined by one blank line (`\n\n`)**:

1. the work item's key and title: `{key} · {title}`;
2. the verb, in plain words (one line per kind, below);
3. the reason, **quoted verbatim with its line breaks kept**, under a label;
4. **overturn only:** the keys `replanOwedOf` derives from `## Supersedes`, as plain keys. The part
   is **omitted entirely** when there are none, and no empty line is left in its place;
5. one sentence asking the planner to re-plan from the reason.

**Catalogue keys, namespace `planningWorkspace.refusalSeed`.**

| part                               | en                                               | zh                                   |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------ |
| 1 · heading                        | `{key} · {title}`                                | `{key} · {title}`                    |
| 2 · verb, `decision_approval`      | `Changes were requested on this decision.`       | `这个决策被要求修改。`               |
| 2 · verb, `decision_confirmation`  | `This decision was overturned.`                  | `这个决策已被推翻。`                 |
| 2 · verb, `decision_choice`        | `None of the options on this choice was picked.` | `这个选择的选项都没有被选中。`       |
| 3 · reason                         | `The reason given:\n“{reason}”`                  | `给出的理由：\n“{reason}”`           |
| 4 · supersedes (overturn, ≥ 1 key) | `The work items it superseded: {keys}`           | `它曾取代的工作项：{keys}`           |
| 4 · key separator                  | `, `                                             | `、`                                 |
| 5 · the ask                        | `Re-plan this work item from that reason.`       | `请根据这个理由重新规划这个工作项。` |

**The whole turn, en** (overturn with keys; the other two kinds drop part 4 and swap part 2):

```text
{key} · {title}

This decision was overturned.

The reason given:
“{reason}”

The work items it superseded: {key1}, {key2}, {key3}

Re-plan this work item from that reason.
```

**The whole turn, zh:**

```text
{key} · {title}

这个决策已被推翻。

给出的理由：
“{reason}”

它曾取代的工作项：{key1}、{key2}、{key3}

请根据这个理由重新规划这个工作项。
```

The quote marks are the typographic `“ ”` in both languages, matching the decided record's quote
(MOTIR-6073 panel 4). `{reason}` is `ApprovalGate.noteMd` as stored, and a multi-line reason stays
multi-line inside the quotes. The key and title are the anchor's, which for all three kinds is the
refused work item itself.

### The ADDRESS

`plan=replan&planFrom=refused-gate&planGate=<gate id>`. `planGate` is the eighth owned name, and
MOTIR-6210 adds its row to §"The ADDRESS" above together with `launcher.test.ts`. This section does not
edit that table. The address is **kept** while the seeded planner is open, so a reload before Send
seeds the draft again and a reload after Send resumes the session through `seededSessionId`. Close
strips it with the other seven.

### GIVES / TAKES

- **MOTIR-6208 (the seed read)** — GIVES the contract above as the drawn text, already implemented in
  its catalogue. TAKES nothing.
- **MOTIR-6210 (the overlay)** — GIVES the loading shape (the seed read inside the existing
  `PlanningWorkspaceSkeleton` window, so there is no live composer to disable), the seeded rail, the
  resumed return and the silent fall-back. It also asks for **two things its criteria do not yet
  name.** (1) The starter chips are hidden while an `initialDraft` is present. (2) A session opened
  through the seed's `seededSessionId` is a RESUME: `state.reopened` stays `null`, so the rail does
  not claim _"Reopened from the Plans page"_. Its criterion _"while the seed loads, the composer is
  disabled"_ is met by the skeleton, where no enabled composer exists. A component test can assert
  that no textbox and no re-plan placeholder render while the fetch is pending.
- **MOTIR-6211 (the hand-off and the door)** — GIVES the ask and the yes / Not now paths, drawn on
  both hosts. **TAKES _"open it the moment the decision commits"_.** The amended wording is in
  §"The amendment of 2026-09-25" below.
- **MOTIR-6209 (the Plans row)** — nothing on this surface. See `design/ai-planning/design-notes.md`.
- **MOTIR-6068 (the story)** and **MOTIR-6213 (its E2E)** — the amendment below TAKES _"as soon as the
  decision is recorded"_ from the story's first criterion, and changes the E2E's first step.

### The amendment of 2026-09-25 — confirm before the seeded planner opens

**The design gate came back CHANGES REQUESTED on 2026-09-25.** The reviewer's note, verbatim: _"Let the
user confirm he wants to go to motir AI to replan the work item."_ Every sheet except sheet 1 is
unchanged. The seeded composer, loading, return, fall-back and contract are all as before, because the
ask sits in front of them. The copy for the ask:

| key (suggested; MOTIR-6211 owns the namespace) | en                                                                               | zh                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `approvalGate.replanAsk.title`                 | `Re-plan {key} with Motir AI?`                                                   | `用 Motir AI 重新规划 {key}？`                             |
| `approvalGate.replanAsk.opens`                 | `Motir AI opens on {key} with your reason already written as the first message.` | `Motir AI 会在 {key} 上打开，并把你的理由写成第一条消息。` |
| `approvalGate.replanAsk.unsent`                | `Nothing is sent until you send it — you can edit it first.`                     | `在你发送之前不会发出任何内容——你可以先修改。`             |
| `approvalGate.replanAsk.yes`                   | `Re-plan with AI` (the door's own label)                                         | `用 AI 重新规划`                                           |
| `approvalGate.replanAsk.no`                    | `Not now`                                                                        | `暂时不用`                                                 |

_Not now_ / _暂时不用_ is the planning surface's existing decline (`planningWorkspace.handoff.notNow`).

**The wording proposed for the consumer cards.** This design edits no card; the orchestrator amends
them on the record.

- **MOTIR-6068, acceptance criterion 1.** Replace it with: _"Refusing a `decision_approval` with a
  reason, overturning a `decision_confirmation` with a note, and pressing *None of these* on a
  `decision_choice` with a reason each, once the decision is recorded, ASK the person in the decided
  band whether to re-plan the work item with Motir AI. Only **Re-plan with AI** opens the planning
  surface over the current page. **Not now** (or Esc) opens nothing and leaves them on the decided
  record, with its Re-plan with AI door."_ In the journey, "Right after the press, the planning
  surface opens…" becomes "Right after the press, they are asked whether to re-plan with Motir AI;
  on yes, the planning surface opens…". Verification steps 1, 4 and 5 gain "the band asks; press
  **Re-plan with AI**" before "the planning surface opens". Add a step: _"Press Not now instead:
  nothing opens, and the record shows Re-plan with AI."_
- **MOTIR-6211.** Title: _"A REFUSAL ASKS, THEN HANDS OFF to the seeded planner — after Request
  changes on a decision, Overturn or None of these commits, the decided band asks to re-plan with
  Motir AI and opens the planner on yes; the three decided record bands carry Re-plan with AI in
  place of the overturned band's plain epic entrance (+ user doc, en + zh)"_.
  - Deliver 2 becomes: _"After a successful refusal of one of the three kinds (`isRefusalSeedGate`),
    render the ASK in the just-decided band, in the place of the door. Use the confirm-band grammar:
    a title, two consequence lines, **Not now** (ghost) and **Re-plan with AI** (primary). Focus goes
    to Re-plan with AI. Esc means Not now and stops propagation, so the approval overlay stays open.
    Re-plan with AI calls `open(gate.id)`. Not now removes the ask and shows the door, with focus on
    it. The ask is transient client state for the person who pressed, and is never persisted."_
  - Criteria 1–2 become: _"Pressing Request changes with a reason on a `decision_approval` (overlay or
    item page), Overturn with a note, or None of these with a reason (overlay) shows the ask in the
    decided band and opens nothing. Re-plan with AI closes the approval overlay's address and opens
    the planning overlay at `planFrom=refused-gate&planGate=<id>`. Not now or Esc opens nothing,
    leaves the approval overlay open on the decided record where it applies, and shows Re-plan with
    AI with focus on it."_
  - Add: _"A reload after the press shows the door, never the ask."_ Criterion 3 reads _"No other
    outcome shows the ask or opens the planner…"_. The user-doc section says the planner is
    **offered** after these refusals, not opened.
- **MOTIR-6213.** Title: _"…Request changes on a decision ASKS, then Re-plan with AI opens the seeded
  planner, close and reopen from the door, send and return to the session, then Overturn (Not now,
  then the door) and None of these"_. The E2E's first step becomes: _"press Request changes with a
  reason → assert the band asks 'Re-plan {key} with Motir AI?' and no planning overlay is open → press
  Re-plan with AI → the seeded planner opens."_ The Overturn leg first presses **Not now** and asserts
  that nothing opened, the approval overlay is still open, and the door has focus. Then it presses the
  door. The None of these leg answers the ask with Enter.
- **MOTIR-6210, MOTIR-6208, MOTIR-6209** — unaffected. The ask sits before the `planGate` address is
  written.

Referenced for provenance only: MOTIR-6011, MOTIR-6019, MOTIR-6024, MOTIR-6067, MOTIR-6072,
MOTIR-6073, MOTIR-6154, MOTIR-6156, MOTIR-6159, MOTIR-6207, MOTIR-6236, MOTIR-6238. `ACME-38`,
`ACME-39`, `ACME-41`, `ACME-42`, `ACME-44` and `ACME-47` are sample keys. `cmg7k2q0` is a sample
gate id.

## ⭐ The picked option planned — the planner STARTED on a FOLLOW-UP, and the Plans row of a pick-seeded session (MOTIR-6432, 2026-09-26, revised twice the same day)

**Asset:** `design/ai-chat/planning-workspace--pick-seed.mock.html`, a **DELTA** in three sheets. It
amends MOTIR-6206's published `design/ai-chat/planning-workspace--refusal-seed.mock.html` (sheet 4,
the choice-anchored composer) and `design/ai-planning/plans-sessions--seeded.mock.html` (panel 1, the
seeded row), and **edits neither**. Its running state is lifted from
`design/ai-chat/plan-change-run-live.mock.html` state A (_RUNNING — nothing said_). The ask and the door that open this surface, and the copy table for
them, are `design/work-items/approval-control--pick-plan.mock.html` (§ _The picked option planned_ in
`design/work-items/design-notes.md`).

**The contract.** `docs/decisions/picked-option-planning.md` (MOTIR-6431), and
`docs/decisions/picked-option-planning-starts.md` (MOTIR-6455), which supersedes its unsent turn: yes
STARTS the planning, the turn is sent once, and the yes is the consent to spend. Specified by:
**MOTIR-6431** (the anchor rule and its fall-backs), **MOTIR-6455** (the start and the send-once rule), **MOTIR-6433** (the first turn's parts), **MOTIR-6434** (the
session stamp and the Plans row), **MOTIR-6435** (the start and the send), **MOTIR-6436** (the ask and the door).

### Revision — 2026-09-26, after changes requested

The design gate came back **changes requested**: _"The picked option planned UI is not good, the
planner should know the choice has just been made and it's a follow-up planning."_ The first version
opened the planner exactly like any work-item launch — the `contextual` mode's _in context_ chip, the
lead _Opened in the context of ACME-40._ and the generic opener _What should change — or what would you
like to know?_ — and its first turn named the option but never said it had just been chosen, or that
this was the planning the choice was waiting for. Neither the person nor the planner could tell a
follow-up from any other conversation on that card. **The revision says it on three surfaces at once:**

1. **A FOLLOW-UP framing on the rail.** The chip reads **follow-up** — never _in context_ (a generic
   launch) and never _plan change_ (a re-plan). The lead names the choice it follows, and the opener's
   second line says what just happened and what to do, in place of the generic question.
2. **A _Follow-up to a choice_ card** directly under the opener: the choice's key and title, what was
   chosen and its best-if line (the chosen record's own chips, choice base panel 5a), and that it was
   chosen just now. It is what the conversation is ABOUT, pinned where the conversation starts.
3. **The first turn TELLS THE PLANNER.** Its second paragraph is now _I just chose an option on this
   choice — this is the follow-up planning it was waiting for._ The planner reads the turn, so this is
   the line that makes the model itself know; the chip and the card tell the person.

**What this asks of the code cards** (each amends its criteria on the record when it runs, per the
calendar check on a design newer than the card): **MOTIR-6433** adds the follow-up line to the pick
composer, right after the heading; **MOTIR-6435** opens a `plan`-intent seed in the follow-up framing
(the chip, the lead, the opener line and the card) rather than as a plain forward launch;
**MOTIR-6434** writes the Plans row as **Follow-up to {KEY}**.

### Revision 3 — 2026-09-26, after changes requested again

The gate came back a second time: _"The planner doesn't need more input from the user, the planning can
start. The user should not need to send an extra message."_ Revision 2 still opened the composer with
the turn **pre-filled and unsent**, waiting for a Send the person had nothing to add to. That was
MOTIR-6431's decision, so it was re-planned and recorded first:
`docs/decisions/picked-option-planning-starts.md` (MOTIR-6455). **The planner is now drawn already
started:**

1. **The turn is SENT.** It shows as the person's first message — the shipped user bubble, labelled
   `turn 1`, pre-wrapped as `PlanChangeRail.tsx` renders raw user text — followed by the shipped
   _Sent to Motir AI_ marker.
2. **The planner is WORKING.** The act rows accumulate with the spinner on the newest, and the running
   bar with **Stop** sits above an empty composer: the rail's shipped running state, lifted from
   `plan-change-run-live.mock.html` state A. No new state is drawn.
3. **No pre-filled composer, no Send step, on a pick.** The composer is the running rail's own reply
   field, empty.
4. **The opener's second line no longer invites a send**: _You just chose {label}. Motir AI is planning
   what it gates._
5. **Answered.** The same session a moment later: the act rows complete, the planner's answer under
   them, the running bar gone and the composer idle for a reply. Reopening the door returns to this and
   sends nothing (the send-once rule, MOTIR-6455 §2).

The follow-up framing of revision 2 (the chip, the lead, the card, and the turn's follow-up line) stays.
A refusal is untouched: its turn stays pre-filled and unsent, as MOTIR-6206 drew it.

**What this asks of the code cards:** **MOTIR-6435** sends a `plan`-intent seed's turn itself when the
seed read reports no seeded session (`seededSessionId` null), and resumes that session otherwise;
**MOTIR-6436**'s ask carries the new lines (`design/work-items/design-notes.md` § _The picked option
planned_ → _Revision 3_); **MOTIR-6438**'s E2E has no manual send.

**Composed from.** The stylesheet is lifted verbatim from `planning-workspace--refusal-seed.mock.html`,
and the rail and composer are its sheet 4 markup with only the chip, the lead, the opener line, the
placeholder and the turn changed, plus the card; revision 3 replaces the composer with
`plan-change-run-live.mock.html` state A's markup from the user bubble to the end of its form (the turn,
the act texts and the running bar's label are the only changes; the answered state drops the running
bar and adds one assistant bubble in the rail's own AI-bubble markup). The card is composed from the chosen record's markup
(`bg-(--el-surface-soft)` with `--el-text-secondary` ink, which clears AA there) and the mint / sky tint
chips. The Plans rows are `plans-sessions--seeded.mock.html` panel 1's markup; that sheet is lifted too,
with `.mk-page`, two decoration utilities and the two `sm:` variants re-emitted last so the seed sheet's
`.w-full` / `.pl-11` cannot out-order them. The composer's auto-grow script is lifted verbatim.

### The sheets

1. **The planner STARTED, anchored on the choice's PARENT, right after yes (en and zh).** The follow-up
   framing on ACME-40, the card, the sent turn, and the planner working.
2. **The same session once the planner has answered, and a PROJECT anchor (en; zh answered below).** A
   root choice, a folder-filed one, or a chain whose every ancestor is `done`: the same start on the
   project, and the sent turn says why it opened there, right after the follow-up line.
3. **The Plans row of a pick-seeded session, beside a refusal-seeded one.** The seed link reads
   **Follow-up to {KEY} · chose {label}** and opens the CHOICE work item. The refusal row is
   MOTIR-6206's, unchanged.

### The decisions

- **The turn is built from the stamp, never the body** (MOTIR-6433), so it says what was chosen even if
  the options are edited afterwards.
- **A FOLLOW-UP, never a re-plan and never a generic launch.** The chip, the lead, the card and the turn
  all say so; none of them says re-plan, and none of them asks the generic "what should change".
- **Yes STARTS it; nothing is left to send** (MOTIR-6455). The turn is wholly derived from the choice
  the person just confirmed, so it is sent as their first message, and the planner works at once. A
  refusal's turn carries their own reason, so it stays pre-filled and unsent.
- **Sent once.** A reopen, a second press of the door or a reload resumes the session and never sends
  the turn again.
- **No placeholder flash.** The seed read shares the anchor read's skeleton, and the rail mounts with the
  sent turn and the running state in its first render.
- **A project anchor says so**, right after the follow-up line, so the person knows why the planner
  opened on the whole project.
- **The Plans row names the follow-up** — **Follow-up to … · chose …** — where a refusal's row reads
  **Re-plan of … · {verb}**. The label truncates at `max-w-[10rem]`; the full label is on the link's
  accessible name.

### The copy (en first, then zh)

The first turn, in order (parent anchor):

```
{KEY} · {title}

I just chose an option on this choice — this is the follow-up planning it was waiting for.

The option chosen: {label}
Best if you want: {bestFor}

What this choice gates:
{followUp}

Plan this work with the option chosen.
```

```
{KEY} · {title}

我刚在这个选择上选定了一个选项——这就是它在等的后续规划。

选中的选项：{label}
如果你更看重：{bestFor}

这个选择决定的工作：
{followUp}

请按选中的选项规划这项工作。
```

On a project anchor, one paragraph follows the follow-up line — en: _This choice has no open container,
so Motir AI opened on the project._ · zh: _这个选择没有未完成的上级工作项，所以 Motir AI 在项目上打开。_

| where                                | key (suggested)                                 | en                                                                                         | zh                                                       |
| ------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| first turn, follow-up line           | `planningWorkspace.refusalSeed.pick.followUp`   | I just chose an option on this choice — this is the follow-up planning it was waiting for. | 我刚在这个选择上选定了一个选项——这就是它在等的后续规划。 |
| rail mode chip                       | `planningWorkspace.mode.followUp`               | follow-up                                                                                  | 后续规划                                                 |
| rail lead, parent anchor             | `planningWorkspace.lead.followUp`               | Opened to plan the follow-up to {choice}, on {item}.                                       | 已在 {item} 上打开，规划 {choice} 的后续工作。           |
| rail lead, project anchor            | `planningWorkspace.lead.followUpProject`        | Opened on {project} to plan the follow-up to {choice}.                                     | 已在 {project} 上打开，规划 {choice} 的后续工作。        |
| opener, second line                  | `planningWorkspace.conversation.openerFollowUp` | You just chose {label}. Motir AI is planning what it gates.                                | 你刚选择了{label}。Motir AI 正在规划它决定的工作。       |
| card label                           | `planningWorkspace.followUpCard.label`          | Follow-up to a choice                                                                      | 选择的后续规划                                           |
| card, who and when                   | `planningWorkspace.followUpCard.chosen`         | Chosen by {name} · {when}                                                                  | 由 {name} 选择 · {when}                                  |
| Plans row seed link                  | `aiPlanning.sessions.seed.pickLabel`            | Follow-up to <mono>{key}</mono>                                                            | <mono>{key}</mono> 的后续规划                            |
| Plans row seed link, after the dot   | `aiPlanning.sessions.seed.chose`                | chose {label}                                                                              | 选择了 {label}                                           |
| Plans row seed link, accessible name | `aiPlanning.sessions.seed.pickAria`             | Open {key}, the choice this conversation is the follow-up to (chose {label})               | 打开 {key}，这段对话是它的后续规划（选择了 {label}）     |

The card's _{when}_ is the gate's `decidedAt` rendered relatively (_just now_ / _刚刚_ right after the
press). Its other strings reuse `approvalGate.choice.record.chose` and
`approvalGate.choice.bestIfYouWant`. The keys are suggestions; MOTIR-6433 owns the turn's catalogue
keys, MOTIR-6435 the rail's and the card's, and MOTIR-6434 the Plans row's.

---

## ⭐ Setting the planning TARGET — the Search control, a search with its own field, the `@` hand-off, and Set as target on the canvas (MOTIR-6895, 2026-09-29)

**Mock:** [`target-picker--search-and-canvas.mock.html`](target-picker--search-and-canvas.mock.html),
a DELTA holding only the panels that change. **Story:** MOTIR-6894 — every behaviour below is that
story's, and each paragraph names the acceptance line it draws.

**What it amends, by path.** [`target-picker.mock.html`](target-picker.mock.html) (MOTIR-1490's
design, re-tokened by MOTIR-4346) **panel 1** (the `@` trigger and its dropdown), **panel 2** (the
visible `@` button) and **panel 4** (the dropdown's states); and, from the section
[`@-mention work-item picker in the planning chat (MOTIR-1490)`](#-mention-work-item-picker-in-the-planning-chat-motir-1490)
above, the rule that the query is the inline text after the `@`. It also adds ONE button to the
**selected-card chrome of the shared roadmap canvas** — the action slot owned by `design/roadmap/`
(`ProjectRoadmapCanvas.tsx`, the View · Open slot under a selected card). That chrome is NOT redrawn:
the two shipped buttons are reproduced from their own classes. The existing mocks are records and are
not edited.

**Inherited, not redrawn:** the composer's bottom-aligned geometry and its multi-line growth
(the MULTI-LINE composer section above, decision 2), the target TRAY and its chips (target-picker
panel 2), the row grammar of the results, the target ring + `Target` pill a canvas node wears
(`PlanningTargetFrame`), and the arrival / follow rules (the ARRIVES INSIDE section above).

### What was read and rendered first

- **Read:** `components/planning/PlanChangeComposer.tsx` (the `planning-target-trigger` button, its
  `absolute bottom-1.5 left-1.5` placement, `pl-8` on the field, the `open` / `atLimit` / `dismissed`
  logic and the combobox wrapper), `TargetSearchListbox.tsx` (the popup shell, the four text states
  outside the listbox, the row), `lib/hooks/useWorkItemTargetSearch.ts` (250ms debounce, the
  2-character minimum), `lib/planning/planningTargets.ts` (`findMentionQuery` — the `(?:^|\s)@([^\s@]*)$`
  boundary that ends the query at the first space — `addPlanningTarget`, `MAX_PLANNING_TARGETS`),
  `ProjectRoadmapCanvas.tsx`'s `renderNode` action slot, `PlanningTargetNode.tsx` and
  `PlanChangeCanvas.tsx` (which passes `onView` and `targetIds` but no target action today), and the
  `planningWorkspace.targets` catalogue in both locales.
- **Rendered:** the running planning surface on this branch's dev server, signed in as the seed
  owner — see _Render check_ at the end of this section.

### 1 · The Search control (mock panel 1) — _"The composer shows a Search control with a magnifier icon, a visible tooltip and an accessible name"_

- **Same slot, same geometry, new glyph.** The control IS the shipped `planning-target-trigger`
  button, still `absolute bottom-1.5 left-1.5` inside the field (decision 2 of the multi-line
  composer), still `p-(--spacing-icon-btn)`, `rounded-(--radius-control)`, ink
  `--el-text-secondary` at rest. Only the icon changes, lucide `AtSign` → lucide **`Search`**: a bare
  `@` reads as _mention someone_, and the control's job is to find a work item.
- **Accessible name and tooltip:** **"Search work items to plan"**. The tooltip adds the keyboard
  shortcut as a key cap (`@`), shows on hover AND on keyboard focus, and uses the design system's
  tooltip (`--radius-control`, `--spacing-tooltip-x/y`, `--shadow-elevated`). The button carries
  `aria-haspopup="dialog"` and `aria-expanded`.
- **Hover:** `bg-(--el-card)` / ink `--el-text`. **Focus:** the `--focus-ring-color` ring.
  **Pressed** (its popover is open): `--el-accent-wash` fill, `--el-accent-on-surface` ink.
- **Disabled twice, as today:** at the 20-target cap and while the composer is disabled
  (`disabled:opacity-50`). **At the cap the tooltip is the `limitReached` sentence**, so the reason
  is on the control, not only in the tray. With the composer locked there is no tooltip: the running
  bar already says why.
- **Placeholders are unchanged** (`composerPlaceholder`, `composerPlaceholderTargets`). The visible
  control, not a longer prompt, tells the person the search exists.

### 2 · The target SEARCH popover (mock panel 2) — _"entering `6010`, `#6010`, `motir-6010` and `MOTIR-6010` … list MOTIR-6010 first"_; _"a multi-word title fragment … keeps searching after each space"_

- **The shell is `TargetSearchListbox`'s, unchanged:** `absolute right-3 bottom-full left-3 mb-2`
  over the composer, `rounded-(--radius-card)`, `border-(--el-border)`, `bg-(--el-surface)`,
  `shadow-(--shadow-elevated)`, the mono section label (`sectionLabel` / `sectionLabelQuery`), the
  rows in a `p-1` listbox.
- **NEW — its own search field, as the first row.** A borderless field on `--el-card` with a lucide
  `Search` glyph (`aria-hidden`), `border-b border-(--el-border-soft)`, padding
  `--spacing-control-x/y`, and an `Esc` key cap at its right end (`--radius-kbd`,
  `--el-border-strong`, ink `--el-text-secondary`). Placeholder **"Key, number or title…"**. The
  field is the combobox (`role="combobox"`, `aria-controls` the listbox, `aria-activedescendant` the
  active row, `aria-autocomplete="list"`); the popover is a NON-modal `dialog` named
  "Search work items to plan". **Opening it puts focus in the field.**
- **Why a field and not the inline query:** the inline query is `findMentionQuery`'s text after the
  `@`, which ends at the first whitespace, so `@plan approval` searched `plan`. In a field of its own
  a space is part of the query. The shared search already requires every word in the title, in any
  order.
- **Rows unchanged** — type-hue icon · mono key (`--el-text-secondary`) · title · status `Pill`, the
  active row on `--el-surface-soft`. Rows carry their key, so two projects' `…-6010` are told apart.
  One addition: **the matched words of the title in bold** (`--el-text`, weight 700 — weight, not
  colour, so it holds in every palette and theme).
- **A foot hint line** below the rows: "↑↓ move · Enter add as target · Esc close", 11px,
  `--el-text-secondary` on `--el-card`, `border-t border-(--el-border-soft)`. Shown only when there are
  rows.
- **Search is the shared search, nothing new:** `GET /api/work-items/mention-search` (browsable-project
  scope, 8 rows, 250ms debounce, 2-character minimum). The exact number ranks first because of
  MOTIR-6896, in the shared `quickSearch`; this popover adds no search of its own.
- **Three queries drawn:** `6010` (MOTIR-6010 first, another project's `SITE-6010` below it, then a
  title that merely contains the digits), `MOTIR-60` (the exact key, then every key it prefixes) and
  `plan approval gate` (several words). The rows other than MOTIR-6010 are ILLUSTRATIVE — their keys
  and titles show the ranking, not real items.

### 3 · Every state (mock panel 3) — _"too-short query, loading, no match, an item already a target, the 20-target cap reached"_

| state                                                 | what shows                                                                                                                                                                                                                                                         | copy (en)                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| empty, just opened                                    | the hint, outside the listbox                                                                                                                                                                                                                                      | **Search by key, number or title…** (changed from "Type to search the project's work items…", because the field now takes all three) |
| too short (below `QUICK_SEARCH_MIN_QUERY_LENGTH` = 2) | the hint                                                                                                                                                                                                                                                           | Keep typing to search work items… (unchanged)                                                                                        |
| loading (the debounce + the request)                  | `role="status"`, `Loader2` spinner in `--el-text-faint` (`aria-hidden`)                                                                                                                                                                                            | Searching… (unchanged)                                                                                                               |
| no match                                              | the line                                                                                                                                                                                                                                                           | No work items match "{query}". (unchanged)                                                                                           |
| a row ALREADY a target                                | the row stays; key + title in `--el-text-secondary`; the status Pill is replaced by the canvas node's **Target** pill (lucide `Target` + the real word, `--el-accent-on-surface` ink on `--el-accent-wash`, 1px `--el-accent-on-surface` border, `--radius-badge`) | `nodePill` — Target (reused)                                                                                                         |
| at the 20-target cap                                  | the field disabled; no rows; the line                                                                                                                                                                                                                              | `limitReached` — You can plan around up to {max} work items at once. (reused)                                                        |

- **An already-target row is `aria-disabled="true"`:** ↑/↓ skip it, a click or Enter on it does
  nothing, and the active row is the first PICKABLE one. It is kept in the list because hiding it
  would read as _not found_. `addPlanningTarget` already refuses a duplicate; the design makes that
  visible.
- **The cap state is reached only by `@`.** The Search control is disabled at the cap (panel 1), so
  `@` at a word boundary is the one way in — and it opens the popover in this state instead of typing
  a bare `@`, so the person learns why nothing is offered. Esc closes it.

### 4 · The `@` shortcut (mock panel 4) — _"Typing `@` at the start of a word opens the same search and leaves no stray `@` in the message"_

- **Boundary unchanged:** an `@` at the start of the message or after whitespace (`findMentionQuery`'s
  rule). `foo@bar.com` types an ordinary `@`.
- **The `@` is CONSUMED.** It is removed from the draft the moment it is typed, the caret stays where
  it was, and focus moves to the popover's field. Every key typed after it lands in the search.
- **The pick goes to the TRAY, never inline** — target-picker panel 2's decision, unchanged. The
  sentence the person was typing is intact.
- **The one cost:** a literal `@` at the start of a word cannot be typed in the composer. The shipped
  picker already treated it as a trigger, and it is rare in a planning instruction.

### 5 · The keyboard model (mock panel 5) — the hand-off between a free-text composer and a combobox

| key                    | in the message field                           | in the popover's field                                                                             |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@` at a word boundary | opens the popover; the `@` is consumed         | an ordinary character                                                                              |
| ↑ / ↓                  | caret between lines (unchanged)                | move the active row, skipping already-target rows; wraps                                           |
| Enter                  | sends (unchanged); Shift+Enter breaks the line | adds the active row and **closes** the popover; with no pickable row it does NOTHING (never sends) |
| Esc                    | the surface's own Esc (unchanged)              | closes the popover, is swallowed; focus returns to the message **at the caret it left**            |
| Tab                    | moves focus on (unchanged)                     | closes the popover, as a click outside does                                                        |
| click outside          | —                                              | closes the popover; a click on the canvas also does what it does there                             |
| IME composing          | Enter confirms the candidate (unchanged)       | Enter confirms the candidate, never picks — the same three-signal guard                            |

**Decision — a pick CLOSES the popover.** Reference products: GitHub's `#` issue picker in a comment
box, Slack's `@` mention and Cursor's `@` context picker all close on the pick and put the caret back
in the text being written. Most turns anchor at ONE item, so the common case costs no extra key; a
second target is one more `@` or one more click on the control. Keeping it open for several picks (the
GitHub _Assignees_ menu model) was rejected: focus would stay in a search after the person got what
they came for, and the next key typed for the message would land in the query.

**Decision — Esc returns focus to the message at its caret**, the same place a pick returns it,
whichever door opened the popover. Opened from the control before the caret was ever placed, the caret
goes to the end of the draft.

### 6 · Set as target on the selected canvas card (mock panel 6) — _"Selecting a committed work-item card … shows **Set as target** … without moving the canvas. On a card that is already a target the action reads **Remove target**"_

- **One button added, between View and Open**, in the shipped action slot (`absolute -bottom-3.5
left-1/2 -translate-x-1/2 flex gap-2`). It takes **View's secondary treatment verbatim** —
  `border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)`, `rounded-(--radius-btn)`,
  `px-(--spacing-btn-x) py-(--spacing-btn-y)`, `text-xs font-semibold`, `shadow-(--shadow-card)`,
  hover `bg-(--el-surface-soft) text-(--el-text)` — because **Open stays the one accent action** on the
  card. Icon lucide **`Target`**, the same glyph as the node's Target pill, so the button and its result
  read as one thing. It stops the pointer-down from starting a canvas drag, like its neighbours.
- **Copy:** **Set as target** / accessible name "Set {key} as the planning target". On a card that is
  already a target: **Remove target** (lucide `X`) / "Remove {key} from the planning targets".
- **Set** calls the host's existing `addTarget`: the tray gains the chip and the card takes the
  shipped `PlanningTargetFrame` ring + Target pill. **The canvas does NOT move** — same level, pan and
  zoom. The person picked the card on the level they are looking at, so there is nothing to follow to,
  and MOTIR-6161's rule is that the canvas never moves after the person has navigated.
  **The card stays selected**, so its button flips to Remove target, which calls `removeTarget`.
- **At the cap** Set is disabled (`disabled:opacity-55`, `aria-disabled`) with the `limitReached`
  sentence as its tooltip. **Remove is never disabled.**
- **A leaf** shows View · Set as target (no Open, as today). **A PROPOSED card** (the plan canvas,
  no key yet) shows no target action — it cannot be a target.
- **Opt-in.** _"The action is OPT-IN on the shared canvas, so the Roadmap page does not change."_ The
  canvas is one component on two pages; the action appears only where the host passes it — the
  planning surface. `/roadmap` passes nothing and is unchanged.

### 7 · The access path (mock panel 7)

The door is shipped and unchanged: **Plan with AI** on an item's page or quick view (and the project's
own entrance) opens the planning surface INSIDE that item — canvas left, conversation rail right
(MOTIR-6154; the arrival is `planning-workspace--arrival.mock.html`). On it a target is set two ways:
**A** the Search control in the composer's bottom-left corner (or `@`), and **B** Set as target on the
card selected on the canvas. Both write the same target set, so the tray and the canvas ring agree.

### Copy (en / zh)

| where                                       | key (suggested)                                                 | en                                        | zh                                  |
| ------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| Search control, name + tooltip              | `planningWorkspace.targets.trigger` (reworded)                  | Search work items to plan                 | 搜索要规划的工作项                  |
| popover field placeholder                   | `planningWorkspace.targets.searchPlaceholder`                   | Key, number or title…                     | 键、编号或标题…                     |
| popover field accessible name               | `planningWorkspace.targets.searchLabel`                         | Search work items                         | 搜索工作项                          |
| empty hint                                  | `planningWorkspace.targets.emptyHint` (reworded)                | Search by key, number or title…           | 按键、编号或标题搜索…               |
| foot hint                                   | `planningWorkspace.targets.hintMove` / `hintPick` / `hintClose` | ↑↓ move · Enter add as target · Esc close | ↑↓ 移动 · Enter 设为目标 · Esc 关闭 |
| canvas action                               | `planningWorkspace.targets.setTarget`                           | Set as target                             | 设为目标                            |
| canvas action, accessible name              | `planningWorkspace.targets.setTargetAria`                       | Set {key} as the planning target          | 将 {key} 设为规划目标               |
| canvas action, is a target                  | `planningWorkspace.targets.removeTarget`                        | Remove target                             | 移除目标                            |
| canvas action, is a target, accessible name | `planningWorkspace.targets.removeTargetAria`                    | Remove {key} from the planning targets    | 从规划目标中移除 {key}              |

Reused unchanged: `sectionLabel`, `sectionLabelQuery`, `keepTyping`, `searching`, `noResults`,
`listboxLabel`, `limitReached`, `nodePill`. The keys are suggestions; the two code cards own their
catalogue entries.

### Tokens

Colour only through `--el-*`: `--el-surface` / `--el-card` / `--el-surface-soft` (popover, field, active
row), `--el-border` / `--el-border-soft` / `--el-border-strong`, `--el-text` / `--el-text-secondary`
(all text; `--el-text-faint` only on the `aria-hidden` spinner), `--el-accent` / `--el-accent-text` /
`--el-accent-on-surface` / `--el-accent-wash` (Open, the pressed control, the Target pill),
`--el-type-*` (row icons). Shape only through `--radius-{card,btn,input,control,badge,kbd}`,
`--spacing-{control,btn,icon-btn,tooltip}-*` and `--shadow-{card,elevated}`.

### GIVES / TAKES — every key the mock and this section name

- **MOTIR-6894** (the story) — GIVES: the drawn shape of all four ways in. TAKES: nothing.
- **MOTIR-6895** (this card) — the design itself.
- **MOTIR-6896** (the number match) — GIVES: nothing new; the mock relies on its ranking. TAKES:
  nothing.
- **MOTIR-6897** (the composer UI) — GIVES: panels 1–5, the copy table's composer rows, the keyboard
  table. TAKES: nothing its criteria claim.
- **MOTIR-6898** (the canvas UI) — GIVES: panel 6, the canvas copy rows. TAKES: nothing its criteria
  claim.
- **MOTIR-6899** (story tests) — named only as sample card data on the canvas (panel 6). GIVES / TAKES
  nothing.
- **MOTIR-6154**, **MOTIR-6160**, **MOTIR-6161** — cited as the shipped arrival, target-crumb and follow rules. GIVES / TAKES nothing
  (done).
- **MOTIR-1490**, **MOTIR-4346** — the base design and its re-token. GIVES / TAKES nothing (done;
  their mock is a record and is not edited).
- **MOTIR-6010**, **MOTIR-6011** — sample row and card data (MOTIR-6010 is the story's own example).
  GIVES / TAKES nothing.
- **MOTIR-60**, **MOTIR-600**, **MOTIR-4471**, **MOTIR-5543**, **MOTIR-6157** — ILLUSTRATIVE rows in
  the result lists; their titles are invented to show the ranking. GIVES / TAKES nothing.

### Render check — the shipped surface, rendered on this branch

The planning surface was opened on this branch's dev server (seeded tenant, signed in as the owner,
`/items/PROD-2?plan=contextual&planFrom=work-item&planItem=PROD-2`) and screenshotted before the canvas
and composer panels were finalised. What the render settled, against the first draft of the mock:

- **The canvas card** puts its status Pill top-left and the type icon + mono key on the row BELOW it,
  above the title — the mock's first draft had them on one row. Redrawn to match.
- **The selected card's ring** hugs the card's own border, and the action slot is a row of compact
  `text-xs` buttons straddling the bottom edge; a leaf shows **View** alone. Selecting a card dims the
  cards it is not connected to (unchanged, and not redrawn here).
- **The composer** at rest is one line with the `@` button inside its bottom-left corner, the tray
  (`TARGET` + the entrance's chip) above it, and the placeholder "Ask Motir to plan around these…" —
  as panel 1 draws, with the magnifier in the `@`'s place.
- **The dropdown** opened by the `@` button sits over the composer at the rail's width, with the mono
  section label and the row grammar panel 2 reuses. Typing `60` on this branch already listed PROD-60
  first — MOTIR-6896's number match, committed on this branch — which is the ranking panel 2 draws.
- **The target is the level itself** when the surface opens inside it: the breadcrumb's last crumb
  carries the target glyph (MOTIR-6160). Set as target on a card on that level therefore ADDS a second
  anchor beside the one the surface opened on; it never replaces it.

## ⭐ Debug with Motir AI — the callout's third row, and the debug turn in the rail (MOTIR-7045, 2026-09-30)

**Design system check (first, per the design-system rule).** `package.json` depends on
`@motir/design-system` `workspace:*`, and `app/globals.css` imports `@motir/design-system/theme.css`.
**Verdict: the project is on Motir Design**, so both mocks are built from the package's primitives and
its `--el-*` / shape tokens. The token blocks were extracted from `packages/design-system/theme.css`,
not typed by hand. **Axes:** the root layout (`app/layout.tsx`) sets `data-style`, `data-palette` and
`data-type` on `<html>` from the signed-in person's applied appearance
(`appearancePreferenceService.getApplied`), so the project has no fixed axis values. The mocks draw the
base values (no axis attribute). Every element routes through a token, so any applied axis re-skins it.

**Mocks (both DELTAS):** [`ai-callout-menu--debug-row.mock.html`](ai-callout-menu--debug-row.mock.html)
and [`debug-turn.mock.html`](debug-turn.mock.html). **Story:** MOTIR-7042. **Decision:**
`docs/decisions/conversation-turn-intent.md` AMENDMENT 1 (the third intent, `debug`).

**What it amends, by path.**

- [`ai-callout-menu.mock.html`](ai-callout-menu.mock.html) panels 3–4 (the menu and the row anatomy)
  and § _The Motir callout — the orb becomes a TRIGGER (MOTIR-1811)_ above, including its
  sub-section _EVERY ROW OPENS THE SAME SURFACE_. The rule is kept: the new row has the same href and
  seeds text only.
- [`ask-answers.mock.html`](ask-answers.mock.html) panels 2 and 7 (the answer turn and its states) and
  § _Ask about this project — the cited ANSWER turn, and the chrome that follows the turn (MOTIR-1815)_
  above. A debug turn is a third turn form beside the answer and the proposal.
- [`plan-change-run-live.mock.html`](plan-change-run-live.mock.html) sheet 3 (the act rail) and
  § _The run surface while it is RUNNING (MOTIR-4066)_ above. The act rail gains two kinds.

The existing mocks are records and are not edited. **The widget entrance** is designed in
`design/triage/report-widget--debug-offer.mock.html` and in § _The Debug with Motir AI offer on the
report widget's success state_ of `design/triage/design-notes.md`.

**Read first:** `lib/planning/aiCallout.ts`, `components/planning/AiCalloutMenu.tsx`,
`PlanWithAIFab.tsx`, `PlanChangeRail.tsx` (`Bubble`, the user turn's target row, the act rail, the
marker lines, the `answeredFrom` foot line, the correction marker, `initialDraft` / `autoSendTurn`, and
`state.outOfCredits` → `AiPaywall`), `PlanChangeComposer.tsx` (the running bar) and
`components/ai/AiPaywall.tsx`.

### 1 · The callout's third row (`ai-callout-menu--debug-row.mock.html` panels 1 and 3)

| Element     | Primitive / source                                                  | Copy (exact)                                            | Colour · shape                                                                                                                               |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| row         | `<Link>` in `AiCalloutMenu`, `data-action="debug"`, the shared href | —                                                       | `--radius-control`, `--spacing-control-x/y` · hover and focus-visible `--el-surface` · pressed `--el-muted` · inset 2px `--focus-ring-color` |
| tile        | lucide `Bug`, the NON-primary tile                                  | —                                                       | `color-mix(in srgb, var(--el-accent) 11%, var(--el-page-bg))` · glyph `--el-accent-on-surface` · `--radius-control`                          |
| title       | `aiCallout.actions.debug.title`                                     | "Debug with Motir AI"                                   | `--el-text`, 13px semibold                                                                                                                   |
| description | `aiCallout.actions.debug.description`                               | "Trace a bug to its likely cause and file it in Triage" | `--el-text-secondary`, 11.5px, in every state (6.24:1 on `--el-surface`, 6.18:1 on `--el-muted`)                                             |

- **Registry:** a third entry in `aiCalloutActions(href)`:
  `{ id: 'debug', icon: 'bug', titleKey, descriptionKey, href }`. `AiCalloutIcon` gains `'bug'`, and
  `ICONS` maps it to lucide `Bug`. **Position 3.** Only position 1 wears the filled hero tile. The
  `wrench` / "Help with a task" row reserved in the registry comment has not landed, and takes
  position 4 when it does.
- **No gate of its own.** The orb is mounted only when `showPlanWithAi` holds (Motir AI configured, an
  active project, `ai:plan`). That is exactly who may send a debug turn, so the row is never
  dimmed and never absent on its own.

### 2 · What the row opens: the composer pre-filled, nothing sent (panel 2)

The same surface and href as the other rows, on the project conversation with its shipped opener
("Opened on {project}. What should change — or what would you like to know?") and mode pill. The
composer (`PlanChangeComposer`, `--radius-input`, `--spacing-input-x/y`, `--el-page-bg`, focus ring
`--focus-ring-color`) holds the pre-fill, **unsent**:

```
Something is broken. What happens:
What should happen instead:
```

- Key `shell.aiCallout.actions.debug.prefill`. There are two lines separated by one newline, and each
  ends in a colon followed by one space. The field takes focus with the caret at the **end of the first
  line**. The shipped multi-line composer (MOTIR-6236) grows to fit it.
- **Mechanism:** the shipped `initialDraft` seam (the refusal re-plan's "pre-fill and wait",
  MOTIR-6210). The person may edit or clear the seed, the starter chips stay hidden while it is in the
  field, and nothing is sent on mount. It is **not** `autoSendTurn`, because these words are Motir's
  (§5, A1.3).
- _Why a template and not a starter chip (the ask row's choice):_ a bug report has a shape the widget
  already asks for ("Steps, expected vs. actual"). Once filled in, the two lines read as a report of
  broken behaviour, which is what A1.1 classifies as `debug`.

### 3 · The debug turn, running (`debug-turn.mock.html` panel 1)

- **⚠️ The widget path opens the PROJECT conversation, not an item-anchored thread.** The accept sends
  the seeded turn through the one ask door, carrying the new triage bug's key as its **anchor**
  (`targets`). So the sent user bubble shows a small reference to the bug: the shipped target row,
  "Targeting 1 item" + `PlanningTargetKeyChip` tone `on-accent` (`--el-accent-pressed` /
  `--el-accent-text`, `--radius-badge`, `--spacing-chip-x`, mono 10px). **There is no item-anchored
  header and no target chip in the composer tray**, and the rail head keeps the project mode pill
  (`plan`). The orb path sends with no anchor, so its user bubble has no target row.
- User bubble: `--el-chat-bubble-user` / `--el-accent-text`, `--radius-card`, label "turn 1", with the
  person's title, a blank line and the description (line breaks kept).
- Markers (centred, 12px, `--el-text-secondary`): "Sent to Motir AI" (existing), then the **debug
  hand-off**, new key `conversation.handoffDebug` = **"Reading it as a bug — tracing the likely cause"**,
  in the same slot as the shipped plan-change `handoff`.
- **Act rail** (`<ol>`, `--el-surface-soft`, `--radius-card`; settled rows `--el-text-secondary`,
  the live row `--el-text` with `Spinner size="sm"`). It shows "Reading your request…" (existing), then
  the hand-off act "Tracing the bug…", then the shipped retrieval lines "Read the code graph" / "Read
  the plan tree". It gains two kinds:

  | kind       | mono label | glyph         | line                                        |
  | ---------- | ---------- | ------------- | ------------------------------------------- |
  | `matching` | `match`    | `SearchCheck` | "Checking whether a card already covers it" |
  | `writing`  | `write`    | `FilePenLine` | "Writing the diagnosis onto {key}"          |

- **Running bar** (shipped): `--el-surface-soft`, `--radius-card`, the live line in
  `--el-text-secondary`, and a **secondary** "Stop" (`--el-button-border`, `--radius-btn`,
  `--height-btn-sm`). The composer stays live ("Reply, or refine further…").

### 4 · Finished: the one new element, the OUTCOME line (panels 2–4)

The prose is an ordinary assistant bubble (`--el-chat-bubble-ai` / `--el-text`, `MarkdownView`, the
28px `--el-accent` avatar with the Motir mark). It is Motir AI's diagnosis. **Under it, in the
`answeredFrom` foot slot**, is a new keyed **outcome line**. It has a hairline `border-t
--el-border-soft`, is 12px `--el-text`, and has a leading `FilePenLine` glyph in `--el-text-secondary`
(`SearchCheck` for no write). It is built from the job's **result**, not from the model's words, so it
always names the one card written even when the prose does not. The card is linked with the shipped
`WorkItemRefChip` (`--el-surface-soft`, `--el-border`, `--radius-control`, `--spacing-kbd-x/y`; bug
square `--el-type-bug`; key `--el-link`; status dot; click opens the shipped peek).

| Outcome (A1.4)                              | Key (new, `conversation.debug.*`) | Copy (exact; `{chip}` = WorkItemRefChip)                                                                                 |
| ------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| diagnosis written onto the anchored bug     | `wroteAnchor`                     | "Wrote the diagnosis onto {chip}. It stays in Triage, and nothing else changed."                                         |
| no anchor (orb): one bug filed with it      | `filed`                           | "Filed {chip} in Triage with the diagnosis. Nothing else changed."                                                       |
| an existing card enriched (widget path)     | `enrichedAnchor`                  | "Added the diagnosis to {chip}, which already covers this bug. Nothing new was filed, and {anchorKey} is left as it is." |
| an existing card enriched (orb path)        | `enriched`                        | "Added the diagnosis to {chip}, which already covers this bug. Nothing new was filed."                                   |
| the report could not be grounded (no write) | `ungrounded`                      | "Couldn't trace this to the code, so nothing was written."                                                               |

- `{anchorKey}` is plain text, not a chip, because the turn did not touch it. Marking it a duplicate
  stays the Triage inbox's act.
- "It stays in Triage" is load-bearing: the write neither promotes nor moves status (A1.4), and the
  line saves the person from looking for the bug on the board.
- **Could not ground** (panel 4) is drawn although the card listed four states. A1.4's fourth row and
  Consequence 2 make it a terminal state. It is an ordinary bubble, not the error block.
- **Correction (§3, A1.5):** the latest debug result carries the shipped correction marker (`--el-link`,
  underlined, 12px semibold) reading **"Answer this instead"** (existing `correctToAsk`). It re-runs the
  user turn as `ask`, and the write **stays**. Which label the marker shows under an ask or plan-change
  turn now that there are three intents is for MOTIR-7050. This design draws only the label under a
  debug result.

### 5 · Out of credits (panel 5)

The shipped `<AiPaywall triggeredOutOfCredits />` in the rail's own slot, **unchanged**: a `Card`
(`--el-card`, `--el-border`, `--radius-card`, `--spacing-card-padding`), a 48px icon chip
(`--el-tint-yellow`, `Pause` in `--el-warning`, `--radius-control`), serif title in `--el-text`, body in
`--el-text-muted` on the white card (4.54:1), primary "Upgrade plan" + secondary "Buy credit top-up"
(size md), and the note in `--el-text-secondary`. The owner copy is "Planning is paused — you're out of
credits" / "The {org} organization has used all of this month's {allotment} {tier} credits, so new
planning runs are paused. Existing plans stay fully editable." / "Renews {date} · or upgrade now to
keep planning." The member and tier-gate faces are unchanged too. Nothing is written, and the user turn
stays on the thread.

> **Recorded, not fixed here:** the reused paywall's noun is _planning_. A debug turn inherits that
> wording because the card says to reuse the treatment. Renaming it changes every AI surface that shows
> the paywall.

### Copy index (new strings)

- `shell.aiCallout.actions.debug.title` "Debug with Motir AI" · `.description` "Trace a bug to its
  likely cause and file it in Triage" · `.prefill` "Something is broken. What happens:⏎What should
  happen instead: "
- `planningWorkspace.conversation.handoffDebug` "Reading it as a bug — tracing the likely cause"
- `planningWorkspace.conversation.act.matching` "match" · `act.matchingLine` "Checking whether a card
  already covers it" · `act.writing` "write" · `act.writingLine` "Writing the diagnosis onto {key}" ·
  `progress.redirectedDebug` "Tracing the bug…"
- `planningWorkspace.conversation.debug.{wroteAnchor,filed,enrichedAnchor,enriched,ungrounded}` (the
  table in 4)

No composer intent control, no debug mode, no new panel: the chrome follows the latest turn (ADR
Consequence 1), and after a debug turn the canvas footer rests, because nothing is proposed.

## ⭐ The user bubble carries NO label — `turn N`, `· refine` and `· answer` are retired (MOTIR-7497, 2026-10-03)

**Amends** every section above that draws or specifies a label on a user bubble: §_The conversation_
(panel 3, `turn 1` → `turn 2 · refine`), the planner-speaks section's note that the `label` slot is
"used only by user turns today (`turn 1`, `turn 2 · refine`)", the multi-line composer section
(`turn 1`, pre-wrapped), and the debug-turn section's user bubble (label "turn 1"). It also amends
`design/triage/design-notes.md` § _Panel 4 — the hand-off_ and the guide conversation drawn in
`design/workbench/workbench--live.mock.html`. Those mocks stay as the record of when they were drawn;
this section is the specification.

**The rule.** A user bubble shows **just the message**: no turn number, no `refine`, no `answer`, in
every mode — plan change, ask, debug and guide. The numbering was the thread's own bookkeeping shown
to the person (Yue, 2026-10-03: _"should show no label, just show the message"_).

- **What stays inside the bubble:** the planning-target row (`Targeting N items` +
  `PlanningTargetKeyChip` tone `on-accent`) and the line-broken body, both unchanged.
- **An answer is still legible as an answer** — by the centred disposition line under it
  (_"Answered — planning resumed"_), never by a caption on the bubble.
- **The `label` slot on `Bubble` stays.** The assistant's question bubble still uses it for `asking`;
  only the user turn stopped passing one.

No new mock: the change removes one line from an existing bubble and adds nothing to draw.

### Copy index (retired strings)

- `planningWorkspace.conversation.turn` "turn {n}" · `.turnRefine` "turn {n} · refine" ·
  `.turnAnswer` "turn {n} · answer" — removed from `en` and `zh`.

## ⭐ Plan something new — the control in the rail head, the confirm, and the new session opening in place (MOTIR-7647, 2026-10-06)

**Mock:** `design/ai-chat/planning-workspace--plan-something-new.mock.html` (a delta; panels 1–8).
**Amends** §_The conversation_ (the rail head, `planning-workspace.mock.html`) by adding one control
to it, and composes the end marker and read-only slot of the session-end delta
(`planning-workspace--session-end.mock.html`, MOTIR-7633) without redrawing them. **Contract:**
`docs/decisions/conversation-turn-intent.md` AMENDMENT 3 (MOTIR-7646).

**The ask.** From inside the planning overlay a person can close the session they are in and start
something else, by pressing **Plan something new** or by saying so. Either path raises the same
confirm. **Confirm** ends the session (`restarted`), gives its cards back, and swaps a new, empty
session into the same overlay. **Keep planning** closes nothing.

### Panel 1 — the control

- Design-system `Button` variant **secondary**, size **sm**, glyph `SquarePen` (14px, `currentColor`),
  label `planningWorkspace.restart.control`. Shape: `--radius-btn`, `--height-btn-sm`; colour
  `--el-button-border` border, `--el-text` ink. Focus: the shipped `--focus-ring-color` ring.
- Placed at the END of the rail head, after the mode `Pill` (`gap-2`). The head is sticky chrome, so
  the control is reachable from any scroll position.
- Pressing it calls `POST /api/ai/plan-change/session/restart/confirm`. It closes nothing; it only
  raises the confirm (idempotent: a confirm already pending is not written twice).
- `data-testid="planning-restart-control"`.

### Panel 2 — the confirm

- A planner `Bubble` (`--el-chat-bubble-ai`, `--el-text`) holding the fixed body
  `planningWorkspace.restart.confirm.body`, rendered from the turn's `confirm: 'new_session'` column
  with catalogue strings (never the stored body), so it reads in the viewer's locale.
- Under the body, `.confirm-acts` (`gap-2`, `mt-2`, wraps): **Confirm** (`Button` primary sm,
  `--el-accent` / `--el-accent-text`) and **Keep planning** (`Button` secondary sm).
- It is the SAME turn whether the control or the person's words (`new_session` from the classifier)
  raised it. The words stay in the thread as the person's own turn. No job runs.
- It is not a planner question: no _asking_ bar, the composer keeps its placeholder. The answers show
  only while the confirm is the LATEST turn of an OPEN session; a later turn leaves it as a record
  without buttons.
- Test ids: `planning-restart-confirm-turn`, `planning-restart-confirm`, `planning-restart-keep`.

### Panel 3 — after Keep planning

The answers leave the bubble, and the shipped centred marker line (`.marker`, `--el-text-secondary`,
12px) records `planningWorkspace.restart.kept`. Nothing else changes; the control stays in the head.

### Panel 4 — the swap

- The rail swaps to the returned session in place; the overlay, canvas frame and rail width stay put.
  The address changes to the new session's (`shallowPush` is not enough here: the session id is a
  route param, so a `router.replace` to the new session's URL).
- The new session shows the head (with the control), ONE earlier-session line (the copied divider's
  idiom: hairlines `--el-border`, `ArrowLeft` glyph, `--el-text-secondary` 12px,
  `planningWorkspace.restart.earlier` · link `planningWorkspace.restart.earlierOpen` in `--el-link`),
  then the shipped opener. The composer is empty and focused.
- **Open it** reopens the ended session read-only by id. It ends with the shipped end marker,
  `data-end-reason="restarted"`, now reading `planningWorkspace.session.end.reason.restarted`, and the
  shipped read-only slot. No copy is offered (A3.4).
- The canvas shows the session's cards back at their pre-session status (ACME-40 at To Do).
- Motion: the thread cross-fades over `--transition-duration`; `prefers-reduced-motion: reduce` draws
  the end state at once. Focus moves to the composer; a polite live region reads the earlier-session
  line.

### Panel 5 — absent and disabled

- **Absent** in a guide conversation (A3.5), in a read-only reopen (another member's session, or no
  `ai:plan`), and in an ended session (it already has its own way forward).
- **Disabled** while a run streams: `disabled` with `aria-describedby` to a `Tooltip`
  (`--el-text` fill, `--el-text-inverted` ink, `--radius-control`, `--spacing-tooltip-x/y`,
  `--shadow-elevated`) reading `planningWorkspace.restart.disabledStreaming`.

### Panels 6–7 — dark parity and the 352px floor

Every element above is drawn under `data-theme="dark"`; all inks are `--el-text`,
`--el-text-secondary`, `--el-accent-text` and `--el-link`, which clear AA on both themes. At the
rail's 352px floor the control keeps its full label beside the mode chip and the confirm's two answers
wrap before they shrink.

### Copy index

| key                                              | en                                                                                      | zh                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `planningWorkspace.restart.control`              | Plan something new                                                                      | 规划新内容                                                 |
| `planningWorkspace.restart.confirm.body`         | Start something new? This closes the current planning session and gives its cards back. | 开始新的规划？这会关闭当前的规划会话，并归还它占用的卡片。 |
| `planningWorkspace.restart.confirm.yes`          | Confirm                                                                                 | 确认                                                       |
| `planningWorkspace.restart.confirm.keep`         | Keep planning                                                                           | 继续规划                                                   |
| `planningWorkspace.restart.kept`                 | Kept planning                                                                           | 已继续规划                                                 |
| `planningWorkspace.restart.earlier`              | Your earlier session is closed                                                          | 你之前的会话已关闭                                         |
| `planningWorkspace.restart.earlierOpen`          | Open it                                                                                 | 打开                                                       |
| `planningWorkspace.restart.disabledStreaming`    | Available when this run finishes                                                        | 本次运行结束后可用                                         |
| `planningWorkspace.session.end.reason.restarted` | you started something new · {when} (was "you started over · {when}")                    | 你开始了新的规划 · {when}                                  |

`session.end.reason.restarted` changes because "started over" reads like the in-session START OVER
(`clear_plan`), which keeps the session.

## ⭐ The correction runs one way — no "Propose changes instead" under an answer (MOTIR-7924, 2026-10-09)

**Amends** _The correction marker, and the redirect's second stream_ in
§ _Ask about this project_ (MOTIR-1815), and
`docs/decisions/conversation-turn-intent.md` AMENDMENT 3 is its record. No delta
mock: the change draws nothing new. It takes one element away.

- **Under an answer there is no correction marker at all.** Whether a turn
  becomes a planning run is the planner's call, never a button. A person who
  wants changes types them in the composer, and the planner reads that turn.
- **Under a proposal (and a debug result), "Answer this instead" is unchanged**
  in vocabulary, position and states, with one fix: it is as wide as its label
  (`w-fit self-center`), not a full-width row. The log is a flex column, and the
  stretched button caught clicks anywhere on its line.
- **The passive markers stay.** _"Re-read as a plan change"_ still labels a
  turn corrected that way before this change; _"Re-read as a question"_ labels
  the remaining direction.
- **Retired copy:** `planningWorkspace.conversation.correctToPlan` and the
  short-lived `correctConfirm.*` confirm, removed from every locale.

---

## ⭐ The per-call line on the planning rail — calls nest under their step, and the record stays whole (MOTIR-7975, 2026-10-09)

**Amendment to `design/ai-chat/plan-change-run-live.mock.html` sheet 3 and to the
MOTIR-4066 section above, _"The run surface while it is RUNNING"_.** Story
**MOTIR-7974** makes every tool call the planner takes produce its own line as the
call **starts**: _Reading `lib/auth/passwords.ts`_, _Searching work items for
"billing"_, _Looking up MOTIR-1234_. One planning run makes dozens of calls, and
one author session alone makes a dozen. This section decides where those lines go.
**MOTIR-7979** builds the rendering to it, and **MOTIR-7976** (the frame parsing,
shipped) does not wait on it, because every grouping here is derived at render
time from the flat act record.

**Asset:** `plan-change-run-live--per-call.mock.html`, a **delta** mock holding only
the panels that change. `plan-change-run-live.mock.html` is a record and is not
edited.

| Panel | What it shows                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------- |
| **1** | A live step with its calls: en, zh and dark, with the pinned bar                                |
| **2** | A finished step, folded and expanded, plus a step that made zero calls                          |
| **3** | Three parallel author sessions, grouped (decided) beside chronological (rejected)               |
| **4** | The pinned running bar: no call yet, one live step, parallel sessions, stopping                 |
| **5** | The marks (failed, refused, a matched `blocked`), light and dark, and the shipped `blocked` row |
| **6** | Generic and unknown lines, with the frame that produces each                                    |
| **7** | Truncation: before and after per object kind, the focused object with its tooltip, zh and dark  |
| **8** | The `retrieval` row beside a call line                                                          |
| **9** | Measured in chromium at 1366 × 768 and 1440 × 900, and the floor rail drawn at its real height  |

### Rendered before drawn

Every shipped fragment on the board is the emitted markup of `PlanChangeRail` at
motir-core f6b31b4, captured with `tests/helpers/renderWithIntl` →
`container.innerHTML` in the `streaming` phase, in en and zh. The stylesheet is
Tailwind's own output for the page's classes, compiled by the repo's
`@tailwindcss/postcss` over `@motir/design-system/theme.css`. The render showed
three things that reading the `.tsx` alone would not:

- **The whole act `<ol>` sits inside the one `aria-live="polite"` region**
  (`plan-change-progress`), so every appended row is announced. One row per call
  would have a screen reader read the log aloud. That is why the live region
  changes below.
- **The interim `call` arm prints _"Read the code_read"_** for a `read_file` call.
  `RETRIEVAL_FAMILY_KEY` has no `code_read` entry, so the raw family name lands in
  the line. MOTIR-7979 replaces that arm with the lines in this section.
- **The interim arm gives every call outside `lay` and `author` the mono label
  `retrieval`.** Here a call line has **no** label column: the mono column stays
  the axis a reader skims, and it names steps only.

### ⚠️ Sheet 3's rule, amended on the record (2026-10-09)

The MOTIR-4066 section says act lines are _"never re-ordered, never collapsed and
never de-duplicated … a rail that folds them into '2 lookups' has turned a record
into a summary"_. Its own measurement says about nine rows fit at the floor. One
row per call, appended flat, is the log sheet 3 forbids. Folding calls risks the
summary it also forbids. **The sentence now reads:**

> Act lines append. They are never re-ordered, never merged, never
> de-duplicated, and none is dropped. A step's call lines are drawn nested under
> that step's row. A finished step folds them behind a disclosure that carries
> their count, and an open step shows its newest two with the rest behind an
> _earlier calls_ row. Folding is presentation only: expanding shows every call,
> in arrival order, one row each.

**What is kept, unchanged:**

- the act record is still an append-only flat list (the hook's `acts`);
- step rows, `retrieval` rows without a call id, and the loud `frame: <kind>` row
  still append and never collapse;
- two identical calls are still two lines;
- the mono label column is still the skim axis, and it names steps.

**What changed:** a call line may be **out of view behind a disclosure**, and the
disclosure always says how many lines it holds and how many of them failed.
"2 lookups" was forbidden because it **replaced** two lines. "2 calls" opens onto
both.

### How a call finds its step (derived at render time)

**Step rows** are the acts `reading`, `redirected`, `searching`, `drilling`,
`laying`, `authoring` and `validating`. The other act rows (`submitted`,
`retrieval`, `note`, `proposed`, `unknown`) never take calls.

1. A call **with an `itemRef`** joins the most recent `authoring` step whose title
   or key equals that ref. motir-ai sends the author session's own ref, which is
   the title the `authoring` frame names until the card has a key.
2. Any other call joins the **most recent step row before it**.
3. A call with **no step before it** renders as its own top-level row in the
   call-line markup. It is never dropped.

**Open and finished.** The open steps are:

- the most recent step;
- when that step is `authoring`, every `authoring` step back to the previous
  step of another kind (the parallel level, per MOTIR-7782).

Every other step is **finished** and folds. When the run ends (done, stopped or
failed), every step folds. **A step a reader expanded stays expanded.** Nothing
auto-folds a group the reader opened.

**What is live, and how it is inked.**

- An open step's row is at `--el-text` with its own glyph.
- The newest call in each open step carries the shipped spinner, at `--el-text`.
- Earlier calls are at `--el-text-secondary`.
- An open step with **no calls yet** carries the spinner on its own row, which is
  exactly the shipped row.
- A finished step's row is at `--el-text-secondary`.

So when a step and its call are both "current", the step row says **what** is
being worked on, and the spinner sits on **the call doing it**.

**The open window: the newest two.** An open step shows its newest **two** call
lines. Older ones sit behind an _N earlier calls_ row at the top of the group,
which is a real disclosure. The number decided it (panel 9 and the table below):

- With every call open, at 1366 × 768 and eight calls per session, the rail
  auto-scrolled to the newest act names **1 of 3** live sessions.
- With a window of three it named 2 of 3.
- With a window of two it names all three at every run length measured.

### Parallel author sessions: grouped, not interleaved

Each call joins its own step's group, keyed by the session's item ref (rule 1
above). **A reader tells which item a call belongs to by text alone:** every group
sits under a row that names its item (_Writing Drop the legacy cookie reader_),
and the indent and hairline only repeat what the nesting already says.

**Rejected: chronological interleave with the item named on each line** (panel 3,
right).

- Every line grows by a title, so most lines wrap. The same rail shows four calls
  where the grouped one shows three sessions.
- The reader has to re-assemble each session's sequence from scattered lines.
- The item name becomes the longest thing on every line, so truncation eats it
  first.

### The pinned running bar

The bar still holds one line and truncates from its end, as shipped. It shows:

| when                               | the bar reads                                                       |
| ---------------------------------- | ------------------------------------------------------------------- |
| an open step with no call yet      | the step's own line (shipped)                                       |
| one open step with calls           | its newest call line                                                |
| two or more open `authoring` steps | the most recently started call, then its item: `{line} · {title}`   |
| stopping                           | the shipped _Stopping — finishing this work item first._, unchanged |

In the parallel case **the line comes first** because the bar truncates from the
end. The part that changes on every call survives, and the item, which the record
names anyway, is what gets cut.

### The marks: a call that did not succeed

| mark        | when                                                                                   | drawn                                                    |
| ----------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **failed**  | the matched `retrieval` carries `ok: false`, or `tool_call_failed` with reason `error` | the line, then `· failed`; glyph `x`                     |
| **refused** | `tool_call_failed` with reason `refused` (a walk write the walk refused)               | the line, then `· refused`; glyph `x`                    |
| **skipped** | an inbound `blocked: true` `retrieval` whose call id matches a call                    | the line, then `· skipped — out of lookups`; glyph `ban` |

- **The spinner gives way to the mark.** A marked call is never live, even when it
  is the newest in its step.
- **The word is `--el-text-strong`, the line keeps its ink, and that is all.** No
  `--el-tint-rose`, no `role="alert"`, no `--el-danger*` / `--el-destructive`.
  A failed lookup is not a failed run, which is the same reasoning sheet 4
  applies to _stopped_. The planner reads the refusal and carries on.
- **Folding never hides a failure.** A finished step's count reads
  _5 calls · 1 failed_.
- **An inbound `blocked` frame with no matching call keeps sheet 3's shipped row**
  (`ban` + _Out of lookups — carrying on with what it has._), unchanged. motir-ai
  `main` no longer emits it. MOTIR-7719 removed the retrieval budget, and
  `assembleRetrievalTools` sends `{ tool, family, ok, args }` with no `blocked`
  variant. So no new budget mark is drawn. The row stays so that nothing a
  producer still sends goes unrendered.
- **For MOTIR-7979:** f6b31b4's `call` act carries `outcome: 'failed'` for both
  an error and a refusal. Telling **refused** apart needs `tool_call_failed`'s
  `reason` kept on the act. That is a field on the render card's side, not a
  frame change.

### Generic and unknown lines

| input                                                                                 | line                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------- |
| a known tool whose template needs an object, with the object `none`, missing or blank | its **family's** generic line                 |
| a known tool whose template takes no object (`get_code_health`, `raise_gap`, …)       | its own line                                  |
| a tool core has no wording for, in a known family                                     | the family's generic line                     |
| a family missing or outside the closed set                                            | _Working on the plan_                         |
| an unknown frame **kind**                                                             | sheet 3's loud `frame: <kind>` row, unchanged |

A line is never blank, never `undefined`, and never shows a raw message key.

### Truncation

**The cap is 32 columns of the object.** A CJK character counts as two. Only the
object is shortened: the verb words never are, and a line may wrap to a second
row. The rule per object kind:

| object                                  | rule                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`                                  | keep the first segment and the file name, elide the middle (`packages/…/StyleVignette.tsx`). If that is still over the cap, use `…/` + the file name. If the file name alone is over, keep its end. |
| `query` (`{query}`)                     | keep the start, elide the end (`“sessions that outlive a passwor…”`)                                                                                                                                |
| `query` (`{symbol}`, a code-graph node) | keep the end, elide the start (`…okenIfExpiringWithinGraceWindow`), because the member name is the end                                                                                              |
| a key (`MOTIR-12345`)                   | **never shortened**                                                                                                                                                                                 |
| a title (`item` · `parent` · `{title}`) | keep the start, elide the end                                                                                                                                                                       |

**How the full value is reached.** A shortened object is the only part that
changes behaviour. An object short enough to show in full adds nothing.

- **Pointer:** a dotted underline says there is more, and hovering opens the
  shipped `Tooltip` (design system, hover **and** focus) with the full value in
  mono.
- **Keyboard:** the shortened object is a tab stop (`tabIndex=0`) with the shipped
  focus ring, and the same `Tooltip` opens on focus. A hover-only `title` is not
  used.
- **Screen reader:** the shortened text is `aria-hidden`, and an `sr-only` span
  carries the accessible name _Full path: `<value>`_ (or _Full query_,
  _Full name_, _Full title_). That is the `FolderPlacement` precedent, so the
  full value is read in reading order with no interaction at all.

### The `retrieval` row beside a call line: no

A `retrieval` frame whose call id matches a call is **that call's outcome** and
draws no row. A success changes nothing; `ok: false` marks the call failed. f6b31b4
already applies it that way, and this board draws the decision. A `retrieval`
frame **with no call id** keeps the shipped per-family row, unchanged. That covers
an older producer, and an ask or debug job, whose handlers emit no `tool_call`.

### A11y: what the one live region announces

**Today the whole record is the live region.** Decided:

- The one `aria-live="polite"` region keeps `data-testid="plan-change-progress"`
  and now holds **only** an `sr-only` announcer line.
- The record `<ol>` becomes its next sibling: ordinary content in the transcript's
  `role="log"`, read by browsing.
- **The announcer is replaced when a step row is appended** (its own line, e.g.
  _Writing Expire idle sessions server-side_) **and when a call is marked**
  (_Updating MOTIR-418 — refused_).
- **Calls are not announced.** Parallel steps that start together are announced
  one by one through the polite queue.
- **No live region is added.** The rail's other polite line (MOTIR-7650's _swapped_
  line) is pre-existing and unrelated.
- The disclosures are real `<button>`s with `aria-expanded` and `aria-controls`, so
  their state is announced on activation. Decorative glyphs are `aria-hidden`, and
  the spinner keeps its shipped `role="status"`.

### Primitives composed

| element               | built from                                                                                                                                                                                                                                                            | colour                                                         | shape                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| step row              | the shipped act row, now the first child of its `<li>`                                                                                                                                                                                                                | as shipped (`--el-text` open · `--el-text-secondary` finished) | as shipped                                                                                           |
| **call list**         | NEW `<ol data-testid="plan-change-calls">` inside the step's `<li>`, indented under the label column (`ml-5.5`), left hairline                                                                                                                                        | `--el-border-strong` hairline                                  | layout only                                                                                          |
| **call line**         | NEW `<li data-testid="plan-change-call">`: glyph by verb + the line, **no label column**                                                                                                                                                                              | `--el-text-secondary`; newest open call `--el-text`            | `text-xs`                                                                                            |
| call glyph            | lucide by verb: `file-text` read · `search` search · `waypoints` explore · `scan-eye` look_up · `list-tree` lay · `pen-line` write · `plus` add · `pencil` update · `minus` remove · `shield-check` validate · `message-square` settle; unknown verb `book-open-text` | `--el-text-secondary`                                          | `size-3.5`                                                                                           |
| object                | `path` / `{symbol}` / a key in `font-mono text-[11px]`; a query and a new title in quotes                                                                                                                                                                             | inherits the line                                              | —                                                                                                    |
| **step disclosure**   | NEW `<button aria-expanded aria-controls>` at the end of a finished step's row: `chevron-right` / `chevron-down` + the count                                                                                                                                          | `--el-text-secondary`; hover `--el-surface` / `--el-text`      | `--radius-control`, `--spacing-chip-x/y`, `text-[11px]`                                              |
| **earlier-calls row** | NEW, the same button as the first row of an open step's call list                                                                                                                                                                                                     | as the disclosure                                              | as the disclosure                                                                                    |
| **mark**              | NEW `<span data-testid="plan-change-call-mark">` after the line: `· failed` / `· refused` / `· skipped — out of lookups`; glyph `x` or `ban` in the glyph slot                                                                                                        | `--el-text-strong`                                             | `font-medium`                                                                                        |
| **shortened object**  | NEW focusable span: dotted underline, the `aria-hidden` short form + an `sr-only` full name, wrapped in the shipped `Tooltip`                                                                                                                                         | inherits; tooltip `--el-tooltip-bg` / `--el-tooltip-text`      | focus `--focus-ring-color`; tooltip `--radius-control`, `--spacing-tooltip-x/y`, `--shadow-elevated` |
| **announcer**         | NEW `<p class="sr-only">` inside the existing `plan-change-progress` region                                                                                                                                                                                           | —                                                              | —                                                                                                    |
| running bar           | shipped, its line chosen as above                                                                                                                                                                                                                                     | as shipped                                                     | as shipped                                                                                           |

**Colour** is `--el-*` only, and no token was added. **Shape** is element-semantic
tokens only, with no `data-style` exception. Every new state pairs a word with a
glyph or structure, so no state rests on colour. No dashed or dotted **border**
carries a state. The dotted underline is a text decoration on a shortened value,
not a state.

### Copy, en and zh, keyed on what each tool DOES

**Enumerated at motir-ai `97e73fb` (`main`)**, with these reads:

```sh
for f in planTreeTools codeGraphTools codeReadTools conventionTools lessonTools treeGeneration conversationSession; do
  git -C motir-ai show 97e73fb:src/llm/$f.ts | grep -oE "name: '[a-z_]+'" | sort -u
done
git -C motir-ai grep -n "name: 'web_search'" 97e73fb -- src     # src/llm/gatewayClient.ts:1258
git -C motir-ai grep -n "deepen_node: deepenExecutor" 97e73fb -- src  # treeGeneration.ts:13458, executor-only
```

`assembleRetrievalTools`' `byFamily` (`src/llm/retrievalTools.ts:355`) gathers 18
retrieval tools over the six families. The walk's session tools are the 20 names
`treeGeneration.ts` defines, plus the executor-only `deepen_node` and
`conversationSession.ts`'s `settle_conversation`. `src/llm/walkDriver.ts`, which
the card names, defines **no** tool at that ref: it drives the sessions
`treeGeneration.ts` builds. The same 40 names are motir-ai's narration map
(`RETRIEVAL_CALL_NARRATION` + `SESSION_CALL_NARRATION`, MOTIR-7977/7978).

The wording is a template over the frame's object:

- `{path}`, `{query}` and `{symbol}` take `object.value` for `path` and `query`.
- `{item}`, `{parent}` and `{title}` take the value for `item` and `parent`: a key
  when the card has one, else its title.

A template whose placeholder has no object falls back to the family line.
motir-ai sends structure only; **these strings are motir-core's**
(`planningWorkspace.conversation.act.call.*`, built by MOTIR-7979). `(session)`
means the tool takes the family of the session it runs in.

| family        | tool                         | object                | en                                                   | zh                               |
| ------------- | ---------------------------- | --------------------- | ---------------------------------------------------- | -------------------------------- |
| `plan_tree`   | `skeleton`                   | `none`                | Reading the plan's outline                           | 正在读取计划大纲                 |
| `plan_tree`   | `search_work_items`          | `query` → `{query}`   | Searching work items for “{query}”                   | 正在搜索工作项：“{query}”        |
| `plan_tree`   | `search_work_items_semantic` | `query` → `{query}`   | Searching work items for “{query}”                   | 正在搜索工作项：“{query}”        |
| `plan_tree`   | `get_item`                   | `item` → `{item}`     | Looking up {item}                                    | 正在查看 {item}                  |
| `plan_tree`   | `get_subtree`                | `item` → `{item}`     | Reading the cards under {item}                       | 正在读取 {item} 下的卡片         |
| `plan_tree`   | `walk_blocking`              | `item` → `{item}`     | Tracing what blocks {item}                           | 正在追溯阻塞 {item} 的卡片       |
| `code_graph`  | `code_search`                | `query` → `{query}`   | Searching the code for “{query}”                     | 正在代码中搜索：“{query}”        |
| `code_graph`  | `code_explore`               | `query` → `{query}`   | Exploring the code around “{query}”                  | 正在探索与“{query}”相关的代码    |
| `code_graph`  | `code_callers`               | `query` → `{symbol}`  | Finding what calls {symbol}                          | 正在查找调用 {symbol} 的代码     |
| `code_graph`  | `code_callees`               | `query` → `{symbol}`  | Finding what {symbol} calls                          | 正在查找 {symbol} 调用的代码     |
| `code_graph`  | `code_impact`                | `query` → `{symbol}`  | Checking what changing {symbol} affects              | 正在评估修改 {symbol} 的影响     |
| `code_graph`  | `code_node`                  | `query` → `{symbol}`  | Reading {symbol} in the code graph                   | 正在代码图谱中读取 {symbol}      |
| `code_health` | `get_coding_convention`      | `none`                | Reading the coding conventions                       | 正在读取编码规范                 |
| `code_health` | `get_code_health`            | `none`                | Reading the code-health report                       | 正在读取代码健康报告             |
| `code_read`   | `read_file`                  | `path` → `{path}`     | Reading {path}                                       | 正在读取 {path}                  |
| `code_read`   | `list_changed_files`         | `none`                | Listing the files changed on the branch              | 正在列出分支上改动的文件         |
| `web`         | `web_search`                 | `query` → `{query}`   | Searching the web for “{query}”                      | 正在网上搜索：“{query}”          |
| `lessons`     | `search_lessons`             | `query` → `{query}`   | Searching lessons for “{query}”                      | 正在检索经验教训：“{query}”      |
| `lay`         | `lay`                        | `parent` → `{parent}` | Laying out the level under {parent}                  | 正在铺开 {parent} 的下一层       |
| `lay`         | `drill_into`                 | `parent` → `{parent}` | Opening {parent} to lay its children                 | 正在打开 {parent} 以铺开其子项   |
| `lay`         | `propose_node`               | `item` → `{title}`    | Proposing “{title}”                                  | 正在提议“{title}”                |
| `lay`         | `complete_level`             | `none`                | Finishing this level                                 | 正在完成这一层                   |
| `lay`         | `target_already_covered`     | `none`                | Noting the target is already covered                 | 正在标记目标已被覆盖             |
| `author`      | `author`                     | `item` → `{item}`     | Starting to write {item}                             | 开始撰写 {item}                  |
| `author`      | `deepen_node`                | `item` → `{item}`     | Writing {item}'s description and acceptance criteria | 正在撰写 {item} 的描述与验收标准 |
| `author`      | `raise_gap`                  | `none`                | Flagging a gap in the plan                           | 正在标记计划中的缺口             |
| `item`        | `add_item`                   | `item` → `{title}`    | Adding “{title}”                                     | 正在添加“{title}”                |
| `item`        | `update_item`                | `item` → `{item}`     | Updating {item}                                      | 正在更新 {item}                  |
| `item`        | `remove_item`                | `item` → `{item}`     | Removing {item}                                      | 正在移除 {item}                  |
| `item`        | `log_bug`                    | `item` → `{title}`    | Filing a bug: “{title}”                              | 正在登记缺陷：“{title}”          |
| `validate`    | `validate_plan`              | `none`                | Checking the plan                                    | 正在校验计划                     |
| `settle`      | `settle_conversation`        | `parent` → `{parent}` | Settling what to change under {parent}               | 正在确定 {parent} 下要改什么     |
| `settle`      | `ask_user`                   | `none`                | Writing you a question                               | 正在拟写给你的问题               |
| `settle`      | `clear_plan`                 | `none`                | Clearing the draft plan                              | 正在清空草拟的计划               |
| `(session)`   | `search_planning_rules`      | `query` → `{query}`   | Checking the planning rules for “{query}”            | 正在查阅规划规则：“{query}”      |
| `(session)`   | `report_findings`            | `none`                | Writing up its findings                              | 正在整理发现                     |
| `(session)`   | `log_planning_mistake`       | `none`                | Noting a planning mistake                            | 正在记录一次规划失误             |
| `(session)`   | `log_planning_bug`           | `none`                | Filing a planning bug                                | 正在登记规划缺陷                 |
| `(session)`   | `classify_revision`          | `none`                | Classifying the revision                             | 正在归类本次修订                 |
| `(session)`   | `return_to_conversation`     | `none`                | Returning to the conversation                        | 正在返回对话                     |

| family                           | en (generic line)         | zh                 |
| -------------------------------- | ------------------------- | ------------------ |
| `plan_tree`                      | Reading the plan          | 正在读取计划       |
| `code_graph`                     | Reading the code graph    | 正在读取代码图谱   |
| `code_health`                    | Reading code health       | 正在读取代码健康度 |
| `code_read`                      | Reading the repository    | 正在读取代码仓库   |
| `web`                            | Searching the web         | 正在网上搜索       |
| `lessons`                        | Reading lessons           | 正在读取经验教训   |
| `lay`                            | Laying out a level        | 正在铺开一层       |
| `author`                         | Writing a card            | 正在撰写卡片       |
| `item`                           | Changing a card           | 正在修改卡片       |
| `validate`                       | Checking the plan         | 正在校验计划       |
| `settle`                         | Settling the conversation | 正在收束对话       |
| missing / outside the closed set | Working on the plan       | 正在处理计划       |

| element                                                           | en                                                                | zh                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| failed mark (`ok: false`, or `tool_call_failed` reason `error`)   | · failed                                                          | · 失败                             |
| refused mark (`tool_call_failed` reason `refused`)                | · refused                                                         | · 被拒绝                           |
| skipped mark (an inbound `blocked` matched to a call)             | · skipped — out of lookups                                        | · 已跳过 —— 检索额度已用尽         |
| disclosure on a finished step                                     | `{count, plural, one {# call} other {# calls}}`                   | `{count} 次调用`                   |
| … when any of its calls failed or was refused                     | `{count, plural, one {# call} other {# calls}} · {failed} failed` | `{count} 次调用 · {failed} 次失败` |
| the earlier-calls row in an open step                             | `{count, plural, one {# earlier call} other {# earlier calls}}`   | `更早的 {count} 次调用`            |
| running bar, two or more author steps open                        | `{line} · {title}`                                                | `{line} · {title}`                 |
| announcer, a failed call                                          | `{line} — failed`                                                 | `{line} —— 失败`                   |
| announcer, a refused call                                         | `{line} — refused`                                                | `{line} —— 被拒绝`                 |
| shortened `path` — accessible name                                | `Full path: {value}`                                              | `完整路径：{value}`                |
| shortened `query` — accessible name                               | `Full query: {value}`                                             | `完整查询：{value}`                |
| shortened `{symbol}` — accessible name                            | `Full name: {value}`                                              | `完整名称：{value}`                |
| shortened title (`item` · `parent` · `{title}`) — accessible name | `Full title: {value}`                                             | `完整标题：{value}`                |

### ⭐ Measured, and what the number decided

Measured in Chromium, driven by Playwright, against the mock's
own rail markup at `22rem`. The rail height is the viewport minus the ~120 px of
shell chrome that sheet 5 used, with the ordinary opening above the record (the
opener, one user turn, _Sent to Motir AI_). The scenario is an author-heavy level:
_submit_, a folded _reading_ step, a folded _lay_ step, then three author sessions
live at once. A row is a step's own row, a call line, or an _earlier calls_ row,
counted fully visible before the transcript scrolls. Sessions named are the open
`authoring` rows fully on screen once the rail has auto-scrolled to the newest act.

| viewport   | calls per live session | rows that fit, chosen nesting | live sessions named on screen at the newest act | rows, every call open | sessions named, every call open |
| ---------- | ---------------------- | ----------------------------- | ----------------------------------------------- | --------------------- | ------------------------------- |
| 1366 × 768 | 4 × 3                  | **7**                         | **3 of 3**                                      | 8                     | 3 of 3                          |
| 1366 × 768 | 8 × 3                  | **6**                         | **3 of 3**                                      | 8                     | 1 of 3                          |
| 1366 × 768 | 12 × 3                 | **7**                         | **3 of 3**                                      | 8                     | 1 of 3                          |
| 1440 × 900 | 4 × 3                  | **12**                        | **3 of 3**                                      | 13                    | 3 of 3                          |
| 1440 × 900 | 8 × 3                  | **10**                        | **3 of 3**                                      | 12                    | 2 of 3                          |
| 1440 × 900 | 12 × 3                 | **12**                        | **3 of 3**                                      | 12                    | 1 of 3                          |

**The finding is that the rail fits only six or seven rows at the floor, so it
was always going to scroll.** The number decided two things:

- Calls nest instead of appending.
- An open step shows its newest two.

That keeps every live session named at the moment a reader looks, at both
viewports and every run length measured, while the full record stays one press
away. Sheet 5's invariant is unchanged. The transcript scrolls and the footer does
not. The rail auto-scrolls to the newest act while the reader has not scrolled
away.

### Deliverable

`design/ai-chat/plan-change-run-live--per-call.mock.html` (the delta mock; panels
1–8 plus the measured panel) and this section. `prettier --check` is clean, and
`tests/design-ink-contrast.test.ts` and `tests/design-state-ink-contrast.test.ts`
pass on it. It amends `plan-change-run-live.mock.html` sheet 3 and the MOTIR-4066
section, which stay as records. It gates **MOTIR-7979** (the rendering and the en
and zh catalogues).

## ⭐ The overlay waits with you — the pending question, failed-waiting-to-resume, and the refusal's "Waiting on {name}" (MOTIR-7907, 2026-10-10)

Mock: `planning-workspace--waiting-on-you.mock.html` (a DELTA; composes the shipped rail, composer and session-end parts). Decision MOTIR-7906.

- **Pending question (panels 1, 2).** Reached from Waiting on you, the overlay opens on the question as the pending turn, using the shipped render (`PENDING_QUESTION_ID = 'plan-change-pending-question'`), with the composer focused and its placeholder _Answer Motir AI…_. **Answered:** the pending turn becomes an ordinary turn, the Waiting on you row clears, and the walk's progress line resumes.
- **Failed, waiting to resume (panels 3–6, 8–10).** A hosted attempt that failed no longer ends the session. The overlay shows the **failure block** (where it stopped in the progress line's step words, why, the sentence that the plan so far is kept and its cards stay at Planning), the plan so far left visible on the canvas with its proposals intact, **Resume** in place of retry and of _Start a new session_, and the composer still usable. **A turn sent while failed is held, not a resume:** Resume is the only thing that restarts the walk (an ordinary submit is refused on a failed walk; MOTIR-7916); the composer's note is carried into the next attempt. Resuming: Resume disabled and the progress line returns. Failed again: the new reason replaces the old with _Second attempt_. _Plan something new_ from this state is MOTIR-7647's control, placed and not redrawn; confirming it ends the session and clears the To resume entry.
- **Who may resume (changed after review, 2026-10-10):** the starter OR a project manager. Panel 3b draws a manager opening another member's failed session (Resume enabled, _started by {name}_, no hold taken); panel 3c draws a plain member who did not start it (read-only: no Resume, no composer, the sentence naming who can).
- **SUPERSEDED:** MOTIR-7633's state _attempt failed → Closed · Start a new session_ **for a hosted attempt**. It stands for an attempt a failure ended BEFORE this story (legacy sessions). **STANDS:** the copy offer for non-failure ends, take-back, the read-only view, the end marker.
- **The refusal (panel 7).** A delta on MOTIR-7633's: it names the holder and says **Waiting on {name}** in place of _free by about HH:MM_, keeping the link to their session where the viewer may read it. The sentence under it differs by cause (question · reply · failed) and tells the refused member only what the holder's state is — not the question's text or the failure's reason.
- **Strings:** `planningWorkspace.waiting.pending|answered|cleared|failedHead|stopped|because|kept|resume|resuming|again` and `planningWorkspace.session.refusal.waitingOn|why.question|why.reply|why.failed|openSession`, en and zh as drawn.
- **Tokens:** `--el-*` roles and shape tokens only; the failure keeps the warning role MOTIR-7633 used (`--el-icon-muted` glyph + `Waiting to resume` yellow tint pill; no danger ink).
- **GIVES:** MOTIR-7918 (the whole overlay surface; sized 65 min — the refusal and four failure states are now specified, re-check at claim), MOTIR-7916 (the held-composer rule). **TAKES:** the failed→Closed state from MOTIR-7633 (hosted attempts only).

## ⭐ The overlay on an OPEN failed session whose plan waits — situation 2 (MOTIR-7935, 2026-10-10)

Mock: `planning-workspace--failed-with-waiting-plan.mock.html` (a DELTA on MOTIR-7907's overlay mock; replaces nothing of it). Cites MOTIR-7907's overlay section and the carry design's states 2 and 10 (`planningWorkspace.session.stalePlan.*`).

- **Opened (5a).** The earlier turns, then **one** failure line (_Your last change to this plan could not be made · {when}_, the warning role MOTIR-7633 / MOTIR-7907 keep), the waiting plan unchanged on the canvas with **Approve / Decline** as shipped, and an **enabled chatbox**. No Resume, no retry, no _Start a new session_, no _Closed_ marker: the session is OPEN. States: turn in flight (5b: the sent turn pending, composer disabled) · answered (5c: the failure line leaves the thread, the turns stay, the plan is revised in place as the SAME plan, the entry is gone) · approved from here (5d: the decide door's approved state; the session ends as approve ends it today) · failed again (5e: the turns and ONE failure line for the new failure).
- **⚠️ DESIGN DECISION — only the CURRENT failure is drawn.** The thread draws at most ONE failure line: the single record `findWaitingState` returns. A failure that a later turn cleared, or a newer failure overwrote, is NOT redrawn after a reload, and no list of past failures is drawn. Why: the session stores one failure record and `markFailed` overwrites it; the turns are what persist. A line per past failure would need a failure-history store no card owns and no requirement asks for. No code card is owed a failure-history store by this design.
- **A failed walk beside a waiting plan (6).** The canvas opens on the walk (the entry's first line) with its stop and **Resume**; the waiting plan stays decidable beside it. **The composer is DISABLED, with its reason** — an ordinary turn on a session holding a failed `generating` walk is refused (MOTIR-7916; `classifyFailedWaitingTurn` → `refuse_resume`) and revising the older plan while a walk is half-written would put two live jobs on one session. _Plan something new_ stays offered. The same one-current-failure rule applies.
- **A STALE waiting plan (8a–8c).** Opened: the plan reads _Out of date_, **no Approve** (a stale plan cannot be approved), Decline kept, composer enabled, the failure line present. The turn is **answered with the carry design's stale-plan message** (the finished work item named, **Plan it again**) and the failure line **stays** — nothing was spent, so nothing cleared. After **Plan it again**: the new plan is written in the same session, the failure line leaves (the accepted fresh attempt binds a turn and clears the failure), the out-of-date plan stays reachable, and the entry leaves To resume.
- **Strings:** `planningWorkspace.waiting.failureLine|failureLineAgain|holdReason|writing`, en and zh as drawn; carry strings cited, not new.
- **GIVES:** MOTIR-7941 (the overlay states, the one-current-failure rule and the stale placement; 80 min — now fully specified, still fits), MOTIR-7938 (the composer-hold reason). **TAKES:** the stale-plan message from the carry design's state 10.

---

## ⭐ The planning thread while a run works — answer, forward, offer, ask (MOTIR-7992, 2026-10-09)

**Design system, read first.** Branch (a), on Motir Design. `package.json` depends on
`@motir/design-system` (`workspace:*`, 0.13.0 in `packages/design-system/package.json`),
and `app/globals.css` imports `@motir/design-system/theme.css`. Both checks hold. The
project's own axes are the ones `app/layout.tsx` writes (`data-style`, `data-palette`,
`data-type` from `applied.*`), and the board is drawn at the package defaults those axes
resolve to for a fresh workspace. The package exports `./mock`, but this surface is the
product's own rail, `PlanChangeRail` + `PlanChangeComposer`, not package parts, so the mock
composes that rail's emitted markup and compiles the stylesheet over `theme.css`, exactly
as the MOTIR-7975 delta does. Parts the package lacks, each **product-local**: the planner's
START OVER offer (the shipped asking bubble plus the shipped A3.2 two-button group), the
paused bar (the running bar with a different leading glyph and a dashed frame), and the
answered-offer record line. None is proposed for the package: each is a composition of
shipped pieces.

**Amends** `design/ai-chat/plan-change-run-live.mock.html` (MOTIR-4066), sheets 2 and 4
(the four states, and the queued label and marker). That mock is a record and is **not
edited**. **Composes, and does not redraw,** `plan-change-run-live--per-call.mock.html`
(MOTIR-7975): the step row, its nested call lines and the folded `N calls` disclosure are
that board's grammar as it stands on `main`. It also leans on `ask-answers.mock.html`
(MOTIR-1815) for the cited answer and on `plan-change-planner-speaks.mock.html`
(MOTIR-2225) for the asking bubble.

**Drawn from** the decision page for **MOTIR-7991, version 1** (approved 2026-10-09T18:06Z).
Nothing it rules is re-opened here: the confirmation form, the START OVER button's
compatibility with turn-intent A3.1, the three planner verdicts and the two words
_ambiguous_ and _unclear about WHAT_ are taken as written.

**Asset:** `design/ai-chat/plan-change-run-live--answer-or-forward.mock.html`, a **delta**
holding only the panels that change. Every panel is the one 22rem running rail (header,
the original ask, the act rail, the pinned footer with the running bar and the composer),
so each state compares against the same picture. Each panel's caption carries its state
number. Light is drawn throughout, **dark** in panel 10 (states 2, 4, 6, 9a, 11, 12 on a
real `data-theme="dark"` scope) and **zh** in panel 11 (states 2, 6, 9a, 11).

| Panel | States                                                        |
| ----- | ------------------------------------------------------------- |
| 1     | 1 answer streaming · 2 progress answer · 12 cannot read       |
| 2     | 3a a committed card · 3b a proposal, with its canvas node     |
| 3     | 4 forwarded → queued → read, and two changes at once          |
| 4     | 5 the ambiguous offer: offer · confirmed · left unanswered    |
| 5     | 6 the START OVER offer · 7a finishing · 7b paused             |
| 6     | 8a started over · 8b declined → applying, and both reloaded   |
| 7     | 9a the question · 9b the typed answer · 9c resumed            |
| 8     | the three-way distinctness strip, with its pair table         |
| 9     | 10 late change → revision · 11 refused, text kept · 13 no run |
| 10    | dark                                                          |
| 11    | zh                                                            |

### The one rule that organises it: who is speaking is told by what the run is doing

While a run works there are two voices in one thread and a person has no reason to learn
their names. Three channels, three treatments, and every state below is one of them:

| Channel                                                        | What it is on screen                                                                                                                                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The planner working**                                        | The **act rail**: the boxed `--el-surface-soft` list with the mono step column, and the **running bar** beneath it. The answering session never writes here.                                                          |
| **The answering session** (answer, acknowledgement, offer)     | An **ordinary assistant bubble** (`--el-chat-bubble-ai`, no label). It is followed, where it matters, by one passive line: _Answered on the side — nothing was sent to the run._                                      |
| **The planner asking the person** (START OVER offer, question) | The shipped **asking bubble**: `--el-warning-surface` fill, `--el-warning-text` ink, the label slot filled with the glyph and the word **asking**. With the paused bar beneath, it means _the run is waiting on you_. |

The act record keeps its place in the transcript and keeps growing in place. Turns the
person types land **below** it, as a queued turn already does, so the planner's record never
interleaves with the chat.

### State 1 — answering, while the run continues (panel 1)

A question was sent and its answer is streaming. **Two activities share the rail and sit in
different places**: the act rail and the pinned bar are the planner (a spinner on the newest
call line and in the bar); the answer is a bubble below the act record with **its own small
spinner inside the bubble** and a passive line under it, _Answering on the side — the run
keeps going._ The user turn carries **no label, no clock and no marker line**. The bar still
shows the planner's own line and Stop, unchanged.

### State 2 — a progress answer, and its difference from a queued turn (panel 1)

_"How far along is it?"_ is answered from the plan and the step signal: the level being laid
and the cards being written. The turn is **unlabelled**. **The exact difference from state
4ii**, so a reviewer checks a claim and not an impression. Both user bubbles are identical
in fill and ink (`bg-(--el-chat-bubble-user)`, `text-(--el-accent-text)`). A queued turn adds
three things and a question has none of them:

| Element                      | Question (state 2)               | Queued (state 4ii)                                                                                    |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Label slot in the bubble     | none                             | `queued`, `font-mono text-[10px] font-semibold tracking-wide uppercase opacity-80`                    |
| Glyph in the label           | none                             | lucide `clock`, `size-3`                                                                              |
| Marker line under the bubble | none                             | `text-center text-xs text-(--el-text-secondary)`: _Queued — the planner reads this at its next step._ |
| What follows the bubble      | an assistant bubble that answers | an acknowledgement bubble that says it was passed on                                                  |

The answer's own foot is the shipped count line (`answeredFrom`), and one passive line says
**nothing was sent to the run**: that sentence is the thing no screen said before.

### State 3 — explaining a card (panel 2)

**3a, a committed card.** The shipped `WorkItemRefChip` in the sentence that rests on it,
then the shipped count line. Recipe unchanged from `ask-answers.mock.html`.

**3b, a proposal, which has no key yet. Decision: a chip, the shipped proposal chip, with
the word _New_ in the key slot and no key.** The answer carries it as
`[title](motir-ref:planItem:<id>)`, and the rail draws it as `PlanningTargetChip`'s
`proposedWord` variant, the same composition `SupersedesChip` uses: type glyph, **New** in
`font-mono font-semibold text-(--el-accent-on-surface)`, the title; `border border-dashed
border-(--el-accent)` on `bg-(--el-tint-lavender)`, `--radius-control`,
`--spacing-kbd-x/y`.

Justified against how the canvas already selects a proposal:

- **The canvas names a proposal by its frame and by the word _New_.** `PlanItemNode` draws an
  `add` as `border-dashed border-(--el-accent) bg-(--el-tint-lavender)` and fills the
  identifier slot with `t('newItem')`, which is _New_. The chip wears that frame and that
  word, so the sentence and the node are visibly the same thing. The panel draws the node
  beside the chip to show it.
- **The canvas reaches a proposal through one door.** `PlanReviewCanvas` selects a node, then
  View, then the peek in proposal mode, and `SupersedesChip`'s `onOpenProposal(planItemId)`
  already opens that same peek from a chip on the peek's rail. A citation click does what the
  canvas door does, so there is no second way to open a proposal.
- **Plain text would lose the link, and an invented key would lie.** A proposal has no key
  until approval, and `validateProposedBodyRefs` refuses any `motir-ref:` that is not the
  canonical `planItem:` token, so the chip needs no new data. A fake `MOTIR-?` would
  collide with a real key the moment the plan is approved.
- **A proposal removed since the answer was written** (the decline path of state 8b) no
  longer resolves, so the chip degrades to the unlinked frame, exactly as the shipped chip does
  when `planItemId` is absent. It never throws and never shows a stale key.
- **The count line counts keyed work items only.** A proposal is not a work item, so state 3b
  reads _Answered from 1 work item_ when one committed card is cited beside it.

### State 4 — a change: forwarded → queued → read (panel 3)

One turn, three frames, and the **two-at-once** panel.

- **4i · forwarded.** The turn is unlabelled; under it the answering session's short
  acknowledgement, an ordinary assistant bubble: _That is a change, so I passed it to the
  planner. It reads it at its next step._
- **4ii · queued.** The **shipped** label, glyph and marker (`queuedLabel`, the clock,
  `data-testid="plan-change-queued"`), reused, not redrawn. **One catalogue string is now
  false and the rail card owes its rewrite**: `queuedMarker` still says _"…reads this when it
  finishes the work item it is writing"_, which is the phase-boundary rule MOTIR-7991
  supersedes. The line drawn here reads _Queued — the planner reads this at its next step._
- **4iii · read.** The shipped `queuedRead` word, **`read`**, **replaces** the label: no clock
  glyph, and the marker becomes _Read — the planner has it._ (`queuedReadMarker` says _"Read at
  the boundary — folded into this run"_ today, false for the same reason.) Word, glyph and
  marker all change, which is what keeps queued and read apart without a colour. **A change the
  planner rules a CORRECTION ends here:** read, and one new row in the planner's own channel,
  the act rail (`apply`, _Added “Pause the run” to the plan_). Nothing further is asked.
- **Two at once.** The older change is `read`, the newer still `queued`, each with its own
  marker, each with its own acknowledgement. Side by side they differ in word, glyph and
  marker line.

### State 5 — the ambiguous-turn offer (panel 4)

**The decision page chose the person's NEXT TURN, with no button**, and says so in these
words: _"the person confirms by typing their next turn ('yes, forward it'), and the
answering session reads that turn against the offer it just made. No button."_ (MOTIR-7991
v1, Ruling 2.) So no control is drawn.

- **5a · the offer.** An ordinary assistant bubble that ends with the offer and says what has
  not happened: _That could be a question or a change. I have not passed it to the planner,
  and nothing has changed. If you want it as a change, reply “yes, forward it”._ The run keeps
  moving: the bar is the moving bar.
- **5b · the reply.** The person types _yes, forward it_. The **original turn takes the
  shipped queued label and marker in place**: the forwarded turn is the one the person first
  wrote, so nothing is duplicated and the thread shows what was sent. An acknowledgement
  closes it.
- **5c · left unanswered.** The person moves on and asks something else. The offer stays as
  text, **no button was ever on it**, and one passive line under it says _Not forwarded —
  nothing was changed._ (the voice of the shipped `supersededMarker`).
- **No composer hint is drawn for 5.** The placeholder slot is real (below), but the offer
  already names the reply, and a hint that must be cleared when the person moves on is a state
  the decision did not ask for.

### State 6 — the planner's START OVER offer (panel 5)

A forwarded change has been read and ruled a RE-PLAN. One panel:

- **The change turn it answers**, now `read` (4iii's treatment), so the offer visibly hangs
  off it.
- **The planner's turn.** The shipped **asking bubble**, with the label `asking`. It carries a
  one-line reason in the planner's words, then one plain sentence saying what each choice
  does. **How it differs from an answering-session turn**: the asking fill
  (`--el-warning-surface` / `--el-warning-text`), the label `asking` with
  `message-circle-question-mark`, and the paused bar beneath it. The answering session never
  uses that bubble.
- **Exactly two choices, one click each**: **Start over** (primary) and **Keep going and
  apply it** (secondary), `Button size="sm"` in the shipped group,
  `role="group" mt-2 flex flex-wrap gap-2`.
- **No danger ink anywhere.** The bubble is the planner's _question_ tint, not an error. The
  primary is the accent fill, the secondary the outlined button.

**Is the primary a shipped START OVER label? No, it is new.** Searched on `main`: the rail's
`planningWorkspace.restart` namespace holds _Plan something new_, _Confirm_ and _Keep
planning_ (`messages/en.json`, `PlanChangeRail.tsx` `RestartControl` and the A3.2 confirm), and
those belong to the **session** restart, which closes a session and opens a new one. The
mailbox `restart` disposition (`planChangeMailboxService.ts`) has no label in the thread at
all. So **Start over** / **重新开始** is new copy, and it is deliberately not _Confirm_:
pressing it takes the mailbox arm, not the session restart. What **is** reused is the A3.2
confirm's anatomy: an assistant bubble, a `size="sm"` primary and secondary in a labelled
group, and the collapse to a record once answered.

### State 7 — the paused run while the offer waits (panel 5)

The walk is paused: sessions already running finish the work item they hold, and no new one
opens. Two moments, both against state 6's layout, with a moving run beside them for
comparison:

- **7a · finishing.** Two cards are still being written, so **two spinners remain on the
  act rows**. The bar is already the paused bar: _paused — Finishing the work items it holds,
  then waiting for your choice._
- **7b · paused.** Nothing runs. The act rail ends with a `pause` row (_Paused — nothing new
  starts until you choose._), and the bar reads _paused — Waiting for your choice._
- **Stop stays in both**, in the bar's trailing slot, unchanged.

**The paused bar** is the running bar with three changes: the leading **spinner becomes a
static `pause` glyph**, the frame gains **`border-dashed border-(--el-border-strong)`**, and
the line gains a mono word **paused** (`font-mono text-[10px] font-semibold uppercase`) above
it. The fill is still `--el-surface-soft`.

| Distinguishing it from… | …a moving run (state 1)                     | …the shipped stopped state                       |
| ----------------------- | ------------------------------------------- | ------------------------------------------------ |
| Spinner in the bar      | moving has one; paused has a static glyph   | stopped has **no bar at all**                    |
| The word                | none; the bar shows the planner's call line | none; the centred marker _You stopped this run._ |
| Frame                   | solid                                       | not applicable                                   |
| **Stop**                | present                                     | **absent**: the run is over                      |
| The act rail's last row | a live call line with a spinner             | the act record, then the stopped marker          |

Three non-colour channels carry paused (glyph, word, dashed frame), and the bar uses no
warning or danger tint: **a pause is waiting, not failing.** The shipped `See it` jump
appears at the bar's trailing edge, before Stop, only when the question has scrolled out of
view; it is not drawn because every panel here has the question on screen.

### State 8 — the offer answered (panel 6)

- **8a · started over.** The buttons are gone and **one record line** stays under the bubble:
  _You chose to start over._ The line is the shipped marker voice, and A3.2's _Kept planning_
  is its precedent. The thread then hands off to the shipped START OVER arm's own rendering,
  which this asset does not draw.
- **8b · declined → applying.** The record reads _You chose to keep going_, and the planner's
  line is an act row in its own channel: **`apply` — Applying your change to the written work
  items**, with its call lines (_Updating Planning rail_, _Removing Web planning rail_). The
  act rail is moving again and the bar is the moving bar.
- **Reloaded**, both frames: the record is derived from the **stored answer**, not from the
  click, so a reloaded thread draws the same bubble, the same line, **no buttons**, and nothing
  is clickable. The panels draw it as a crop.

**The canvas removal treatment exists and is reused; there is no gap.** A removal is drawn
by `PlanItemNode` with `op: 'remove'`: `border-(--el-border-strong) bg-(--el-muted)
shadow-(--shadow-subtle)`, the struck title in `--el-text-secondary`, the **remove** badge
with `archive-x`, and the reason line. It is deliberately **not** red: MOTIR-4260 and
MOTIR-4475 moved it onto the muted fill so no ink fails AA. Panel 6 draws one proposal in that
frame, with the planner's reason. **One caveat for the render card, not a gap in the design:**
the shipped `remove` row is the review diff's, so confirm that a planner `remove_item` on a
proposal that has no key surfaces as an `op: 'remove'` row and not as the node silently
leaving; the asset's point is that the frame is the shipped one.

### State 9 — the planner steps back to ask what a change meant (panel 7)

The UNCLEAR verdict. The planner has not decided anything; the walk is paused; **the answer
is typed**.

- **9a · the question.** The vague change (_make it better_) is `read`. Directly under it, the
  **planner's turn**, the same asking bubble as state 6, carries the question in its own words
  and one line, _Nothing has been changed yet._ **It has no buttons.** The bar is the paused
  bar from state 7 with its **second wording**: _Waiting for your answer_, the shipped
  `awaitingAnswer` string. Stop is reachable.
- **Composer hint: the slot exists, so it is drawn.** `PlanChangeRail` already swaps the
  placeholder for a pending question: `composerPlaceholderAnswer`, _Answer Motir AI…_. The
  asset draws it. No new control and no new string for the hint.
- **9b · the answer.** The typed reply sits **directly under the question**, in the same
  unlabelled frame; then it goes **forwarded → queued → read with state 4's exact treatments**,
  reused: the queued label and marker, then `read`. **No acknowledgement and no offer to
  forward appear**: an answer to the planner's question is forwarded without a confirm. **The
  tie to the question is the disposition line**, named here as the treatment: once the person
  has answered, the question gains the centred marker line beneath it
  (_Answered — the planner reads it at its next step_) and the reply is the turn that follows.
  That is the shipped `answeredMarker` idiom, with the queued wording until the reply is read.
- **9c · resumed.** Once read, the paused bar gives way to the moving act rail of state 1. The
  question stays above as a **record**, and its line becomes the shipped _Answered — planning
  resumed_. A reloaded thread shows it as text with that line, **never as a pending prompt**:
  the pending state is derived from "no answer after it", not from local state.
- This step-out files **no planning bug**, as the decision rules, so nothing in the thread
  says one was filed.

### The three-way distinctness strip (panel 8)

Three invitations to the person, drawn side by side with their bars: the answering session's
ambiguous offer (state 5), the planner's START OVER offer (state 6) and the planner's
question (state 9a). None uses danger or error ink.

| Pair        | Speaker treatment                                                                       | Buttons             | The bar                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| **5 vs 6**  | plain bubble, no label (side session) versus asking tint, labelled **asking** (planner) | none versus two     | the moving bar with a spinner versus **paused**, _waiting for your choice_                                  |
| **5 vs 9a** | plain bubble versus asking tint, labelled **asking**                                    | none versus none    | moving versus **paused**, _waiting for your answer_; the composer placeholder changes to _Answer Motir AI…_ |
| **6 vs 9a** | **the same** planner treatment, on purpose: both are the planner asking                 | **two versus none** | _waiting for your choice_ versus _waiting for your answer_; the placeholder changes on 9a only              |

What each one is. The ambiguous offer is the **side session reading the person's turn**; it
forwards only on the person's confirmation and the run never stops for it. The START OVER
offer is the **planner offering a remedy** with two clicks. The question is the **planner
asking**, answered by a typed turn. The paused bar is the one thing that is true of the two
planner turns and false of the side session's, and that is by design: a person should be able
to tell _the run is waiting on me_ from _Motir answered me_ at a glance.

### State 10 — a late change becomes a revision (panel 9)

The walk has finished and the plan is not yet closed (the review block still waits). A change
is forwarded. The thread says what happened and where it points: an acknowledgement, then one
note in the shipped **take-back idiom** (`TakenBackNotice`: `border border-(--el-border)
bg-(--el-page-bg)`, a `history` glyph), _Applied as a revision of this plan_, with a link,
**See it on the timeline**, in `--el-link`, to the plan's timeline. It is **not a refusal**:
no tint, no `role="alert"`, and the change turn is `read` like any other.

### State 11 — the run-ended refusal that keeps the text (panel 9)

The run has finished, been stopped or failed, and a forward is refused. **The person's text
stays in the composer** (focused, at its full height, the field's own focus ring). **The
reason sits in the pinned footer, directly above the composer**, never in the transcript where
it could scroll away from the words it explains. It reuses the shipped refusal treatment of
the carry: `CarryDecidedNotice`'s band, `bg-(--el-tint-yellow)`, `--radius-control`,
`--spacing-control-x/y`, `text-xs` in `--el-text-strong`, with the `undo-2` glyph. **No danger
token**: the person did nothing wrong, and nothing failed in their words. Three wordings share
the band: _This run has finished._ · _You stopped this run._ (the shipped stopped line) ·
_This run failed._ followed by the shipped _Your message wasn't sent. It is in the box
below._ (`planningWorkspace.session.carry.takenBackUnsent`).

### State 12 — cannot read the run (panel 1, beside state 2)

An honest assistant answer that says it could not read the plan or its steps and does not
guess. It is the shipped no-answer's shape: **no chip, no count line, no number**. Beside
state 2 the difference is exactly that, plus the sentence. The passive line under it still
says nothing was sent to the run, which is true.

### State 13 — no run in progress (panel 9)

One frame: no bar, no queue, the person's draft in the live composer. A turn typed when no
run is going takes **today's submit path**; the frame exists to say nothing changes.

### Wording, en and zh

The code card is en + zh, so every string is below. Strings that exist today are marked
**shipped**; everything else is new copy for the rail card.

| State | Element                            | en                                                                                                                                                                                                     | zh                                                                                                                                                |
| ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| all   | passive line under an answer       | Answered on the side — nothing was sent to the run.                                                                                                                                                    | 已在一旁回答 —— 没有发送给运行中的规划。                                                                                                          |
| 1     | streaming line                     | Answering on the side — the run keeps going.                                                                                                                                                           | 正在一旁回答 —— 运行照常继续。                                                                                                                    |
| 1     | partial answer                     | It is laying level 3 of 4. Two cards are being…                                                                                                                                                        | 目前在铺第 3 层（共 4 层）。正在撰写的有两张…                                                                                                     |
| 2     | question                           | How far along is it?                                                                                                                                                                                   | 进行到哪一步了？                                                                                                                                  |
| 2     | answer                             | It is laying level 3 of 4, under ⟨MOTIR-7990⟩. Two cards are being written right now — Queue a turn and Pause the walk — and five are finished.                                                        | 目前在铺第 3 层（共 4 层），位于 ⟨MOTIR-7990⟩ 之下。正在撰写两张卡片 —— “排队一轮对话”和“暂停规划”—— 另有五张已完成。                             |
| 2, 3  | count line (**shipped**)           | Answered from 1 work item                                                                                                                                                                              | 依据 1 个工作项作答                                                                                                                               |
| 3a    | question · answer                  | What is MOTIR-7991 for? · ⟨MOTIR-7991⟩ settles how a change reaches the planner while it plans: questions are answered on the side, and only a change is passed on.                                    | MOTIR-7991 是做什么的？ · ⟨MOTIR-7991⟩ 确定了规划进行中变更如何送达规划者：问题在一旁回答，只有变更才会转交。                                     |
| 3b    | question · answer                  | Why is “Pause the walk” in the plan? · ⟨New · Pause the walk⟩ is there so that a re-plan stops new sessions from opening while you decide. It follows from ⟨MOTIR-7991⟩.                               | 计划里为什么有“暂停规划”？ · ⟨新 · 暂停规划⟩ 是为了在你做决定期间，让重新规划不再开启新的会话。依据是 ⟨MOTIR-7991⟩。                              |
| 3b    | key slot (**shipped**)             | New                                                                                                                                                                                                    | 新                                                                                                                                                |
| 4i    | acknowledgement                    | That is a change, so I passed it to the planner. It reads it at its next step.                                                                                                                         | 这是一项变更，我已转交给规划者；它会在下一步读到。                                                                                                |
| 4ii   | label (**shipped**) · marker       | queued · Queued — the planner reads this at its next step.                                                                                                                                             | 待读 · 已排队 —— 规划者会在下一步读到。                                                                                                           |
| 4iii  | label (**shipped**) · marker       | read · Read — the planner has it.                                                                                                                                                                      | 已读 · 已读 —— 规划者已收到。                                                                                                                     |
| 4iii  | correction row (act `apply`)       | Added Pause the run to the plan                                                                                                                                                                        | 已把“暂停运行”加入计划                                                                                                                            |
| 5a    | user turn · offer                  | Maybe the settings card should be split up? · That could be a question or a change. I have not passed it to the planner, and nothing has changed. If you want it as a change, reply “yes, forward it”. | 也许设置卡片应该拆开？ · 这可能是个问题，也可能是一项变更。我还没有把它转交给规划者，也没有改动任何内容。如果你想把它当作变更，请回复“是，转交”。 |
| 5b    | reply · acknowledgement            | yes, forward it · Done — I passed it to the planner as a change.                                                                                                                                       | 是，转交 · 好的 —— 已作为变更转交给规划者。                                                                                                       |
| 5c    | stale line                         | Not forwarded — nothing was changed.                                                                                                                                                                   | 未转交 —— 没有改动任何内容。                                                                                                                      |
| 6     | change turn                        | Forget the web rail — plan this for the mobile app instead.                                                                                                                                            | 不做网页端的规划栏了 —— 改为给移动应用做规划。                                                                                                    |
| 6     | planner reason                     | This changes what most of the plan is for — the cards written so far assume the old ask.                                                                                                               | 这会改变计划大部分内容的用途 —— 目前写好的卡片都基于原来的需求。                                                                                  |
| 6     | what each choice does              | Start over writes the plan again from your new ask. Keep going applies it to the cards already written.                                                                                                | 重新开始会按你的新需求重写计划。继续则把它应用到已经写好的卡片上。                                                                                |
| 6     | the two choices · group label      | Start over · Keep going and apply it · Start over?                                                                                                                                                     | 重新开始 · 继续并应用 · 重新开始？                                                                                                                |
| 6, 9a | label (**shipped**)                | asking                                                                                                                                                                                                 | 提问                                                                                                                                              |
| 7     | bar word · 7a · 7b                 | paused · Finishing the work items it holds, then waiting for your choice. · Waiting for your choice.                                                                                                   | 已暂停 · 正在完成手头的工作项，随后等待你的选择。 · 等待你的选择。                                                                                |
| 7     | act row (`pause`)                  | Paused — nothing new starts until you choose.                                                                                                                                                          | 已暂停 —— 在你选择之前不会开始新的内容。                                                                                                          |
| 8a    | record                             | You chose to start over                                                                                                                                                                                | 你选择了重新开始                                                                                                                                  |
| 8b    | record · planner line              | You chose to keep going · Applying your change to the written work items                                                                                                                               | 你选择了继续 · 正在把你的变更应用到已写好的工作项                                                                                                 |
| 8b    | call lines (**shipped** form)      | Updating Planning rail · Removing Web planning rail                                                                                                                                                    | 正在更新 规划栏 · 正在移除 网页端规划栏                                                                                                           |
| 8b    | canvas reason label                | Reason (**shipped**) · Not needed for the mobile ask                                                                                                                                                   | 原因（**shipped**）· 手机端的需求用不到                                                                                                           |
| 9a    | planner question · note            | Which part should change — the card list, the order, or what a card covers? · Nothing has been changed yet.                                                                                            | 想改哪一部分 —— 卡片列表、顺序，还是某张卡片涵盖的内容？ · 目前还没有改动任何内容。                                                               |
| 9a    | bar (**shipped** string)           | Waiting for your answer · (finishing) Finishing the work items it holds, then waiting for your answer.                                                                                                 | 等待你的回答 · （收尾中）正在完成手头的工作项，随后等待你的回答。                                                                                 |
| 9a    | act row (`pause`)                  | Paused — nothing new starts until you answer.                                                                                                                                                          | 已暂停 —— 在你回答之前不会开始新的内容。                                                                                                          |
| 9a    | composer placeholder (**shipped**) | Answer Motir AI…                                                                                                                                                                                       | 回答 Motir AI…                                                                                                                                    |
| 9b    | vague turn · typed answer          | make it better · split the settings card into profile and billing                                                                                                                                      | 再改好一点 · 把设置卡片拆成个人资料和账单两张                                                                                                     |
| 9b    | question's line while queued       | Answered — the planner reads it at its next step.                                                                                                                                                      | 已回答 —— 规划者会在下一步读到。                                                                                                                  |
| 9c    | question's line (**shipped**)      | Answered — planning resumed                                                                                                                                                                            | 已回答 — 规划继续                                                                                                                                 |
| 10    | change · acknowledgement           | Also add a card for exporting the plan. · That is a change. The plan has finished writing, so I will apply it as a revision.                                                                           | 再加一张导出计划的卡片。 · 这是一项变更。计划已经写完，所以我会把它作为修订应用。                                                                 |
| 10    | outcome note · link                | Applied as a revision of this plan. · See it on the timeline                                                                                                                                           | 已作为本计划的修订应用。 · 在时间线中查看                                                                                                         |
| 11    | band, three wordings               | This run has finished. · You stopped this run. (**shipped**) · This run failed.                                                                                                                        | 这次运行已经结束。 · 你停止了这次运行。 · 这次运行失败了。                                                                                        |
| 11    | band tail (**shipped**)            | Your message wasn’t sent. It is in the box below.                                                                                                                                                      | 你的消息没有发送，它还在下方的输入框中。                                                                                                          |
| 12    | answer                             | I could not read the plan or its steps just now, so I won’t guess how far along it is. Try asking again in a moment.                                                                                   | 我刚才没能读取计划或它的步骤，所以不会猜测进度。请稍后再问一次。                                                                                  |
| 13    | draft                              | Add a card for exporting the plan.                                                                                                                                                                     | 加一张导出计划的卡片。                                                                                                                            |

### Primitives composed

The rail and its parts are the shipped components' markup: `PlanChangeRail` (header, the
`Bubble` pair for the assistant and the user, the system marker line, the act `<ol>`, the
review block), `PlanChangeComposer` (the running bar with `Button` secondary `sm` Stop, the
composer, Send), `Button` primary / secondary / ghost `sm`, `IssueTypeIcon`-grammar chips
(`WorkItemRefChip`, `PlanningTargetChip` proposed variant), `PlanItemNode` for the two canvas
nodes, `CarryDecidedNotice`'s band and `TakenBackNotice`'s note. The act-rail rows are the
MOTIR-7975 grammar. **New compositions** (product-local, none in the package): the paused bar,
the START OVER offer's body and the answered-offer record line.

### Tokens, by role

**Colour, `--el-*` only.** The user bubble `--el-chat-bubble-user` / `--el-accent-text`; the
assistant bubble `--el-chat-bubble-ai` / `--el-text`; the asking bubble `--el-warning-surface`
/ `--el-warning-text`; markers and mono step labels `--el-text-secondary`; the act list
`--el-surface-soft`; the nested call rule `--el-border-strong`; the bar `--el-surface-soft`
with the paused frame `--el-border-strong`; the refusal band `--el-tint-yellow` on
`--el-text-strong`; the proposal chip `--el-tint-lavender` + `--el-accent` + `--el-accent-on-surface`;
the removed node `--el-muted`, `--el-border-strong`, `--el-text-secondary`; Start over
`--el-accent` / `--el-accent-text`; the outlined button `--el-button-border`; links
`--el-link`. **No `--el-danger*`, no `--color-*`, no raw value** anywhere on the board.

**Shape, element-semantic only.** Bubbles and the bar `--radius-card`; the chip, the band,
the note and the call-disclosure toggle `--radius-control`; buttons `--radius-btn` with
`--height-btn-sm`; the composer `--radius-input`, `--height-input`, `--spacing-input-x`;
badges `--radius-badge`; chips `--spacing-kbd-x/y` and `--spacing-chip-x/y`; the band
`--spacing-control-x/y`; nodes `--shadow-card` / `--shadow-subtle`.

**Ink checks.** Every muted-ish line is `--el-text-secondary`; `--el-text-muted` and
`--el-text-faint` are not used. The one tinted-surface ink, `--el-warning-text` on
`--el-warning-surface`, is the shipped asking recipe (about 10:1 in both themes), and the
outlined button's `--el-text` is measured on that tint by `design-state-ink-contrast`.

### What the render card owes (not decided here)

- Rewrite `queuedMarker` and `queuedReadMarker`: both state the phase-boundary rule that
  MOTIR-7991 supersedes. Add `apply` and `pause` to the act-label catalogue.
- The START OVER offer's click calls the shipped `restart` arm, and a decline forwards _apply
  this change to the written work items_ (MOTIR-8007). The paused bar and its wording come
  from the walk's pause (MOTIR-8009).
- An unanswered ambiguous offer goes stale on the next turn, derived from the thread, and a
  reloaded thread derives every record in this asset (8a, 8b, 9c) from stored answers.

### Deliverable

`design/ai-chat/plan-change-run-live--answer-or-forward.mock.html` (panels 1 to 11) and this
section. It amends `plan-change-run-live.mock.html` sheets 2 and 4, which stay as records.
It gates the rail rendering, the START OVER offer in the thread and the hosted pause.

---

## ⭐ Planner narration in the chat panel — the planner's own words, per session, and one control to fold them (MOTIR-8061, 2026-10-09)

**Design system, identified first.** Read `package.json` (depends on
`@motir/design-system`, `workspace:*`) and `app/globals.css` (line 13,
`@import '@motir/design-system/theme.css'`). Both hold, so the verdict is **(a) ON
MOTIR DESIGN**, package **v0.13.0** (`packages/design-system/package.json`). The
project's axes are per person (`app/layout.tsx` stamps the signed-in person's
`data-style` / `data-palette` / `data-type`; a signed-out reader gets none), so the
board renders at the package defaults, which is what a Visitor sees. The package
exports `@motir/design-system/mock` (`renderMock`), but the surface is the
product-local `PlanChangeRail`, which the package does not ship, so the board is
composed from that component's **real rendered markup** with `theme.css` compiled
in, as MOTIR-7975's board was. Parts the package lacks:

- **narration group** (head + hairline message list + disclosure): product-local
  component, because it is the act record's row shape and only the planning rail
  uses it;
- **collapse-all row**: product-local component, for the same reason.

**Amendment to `design/ai-chat/plan-change-run-live.mock.html` sheet 3 and to
MOTIR-7975's section above, _"The per-call line on the planning rail"_.** Story
**MOTIR-8060** makes both planners (the hosted Motir AI planner and
`prompts/plan.py`) write one plain-language sentence per step of work, in their own
words, and keeps those sentences per plan with each session's step words. The user
rejected the per-call lines: _"they are not understandable, the planner says it
with understandable words"_. This section decides how the sentences are drawn.
**MOTIR-8064** builds it; **MOTIR-8062** (the store) and **MOTIR-8063** (the read)
supply the data.

**Asset:** `plan-change-run-live--narration.mock.html`, a **delta** mock holding only
the panels that change. `plan-change-run-live.mock.html`,
`plan-change-run-live--per-call.mock.html`, their sections above, and the
`design/ai-planning` progress-line files are records and are not edited.

| Panel  | What it shows                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| **1**  | Before (shipped, call lines) and after (narration), and the three kinds told apart: reply bubble, step row, message    |
| **2**  | 1, 2 and 6 concurrent sessions, and a long walk (settle → lay → 9 authors → lay) against the 1366 × 768 fold           |
| **3**  | The collapse-all control: expanded, collapsed, one group opened alone, and what it never hides; its labels and memory  |
| **4**  | Display length: a 40-char sentence, a 200-char sentence, an unbroken path, a long head title                           |
| **5**  | zh interface with English narration, en interface with Chinese narration; the `lang` rule                              |
| **6**  | plan.py live beside today's empty MCP rail; returned to mid-run, before → after                                        |
| **7**  | A session ending (before → after), a session with no sentence, stalled, a withdrawn proposal, an unattributed sentence |
| **8**  | Ended: `planned`, `stale`, `approved`, `declined`, expanded and collapsed                                              |
| **9**  | Visitor read-only (expanded, collapsed, en and zh) with the control; no narration (live and ended) with no control     |
| **10** | The data each element reads, and the screen-reader rules                                                               |

Each frame is labelled with its `PlanStatus`, its reader (launcher, teammate or
Visitor) and whether narration is present.

### Rendered before drawn

Every shipped fragment is the emitted markup of `PlanChangeRail` at motir-core
`38a3cc9`, captured with `tests/helpers/renderWithIntl` → `container.innerHTML`, en
and zh, in seven states (hosted live with calls, reopened live, plan.py live with
the MCP notice, Visitor, idle, a pending question, a reply followed by an own
turn). The three "before" rails are those captures verbatim. The stylesheet is
Tailwind's own output for the page's classes over `theme.css`. What the render
showed that the `.tsx` alone does not:

- **A reopened overlay has no act record at all** (panel 6, before). The stream
  acts lived only in the hook; a plan.py plan never had any.
- **The stream's run rows (`submit`, `reading`) would not survive a reopen either.**
  They are kept while live, but nothing a reader needs may live only there, which
  is why the session heads come from the store, not from the stream.

### ⚠️ MOTIR-7975's section, amended on the record (2026-10-09)

**The tool-call lines are no longer drawn in the rail, for either planner.** That
removes the `CallLine` rows, the step disclosure that folded them (_N calls_,
_N calls · M failed_), the open step's _earlier calls_ row, the shortened object
and its tooltip, and the running bar's `{line} · {title}` form. MOTIR-7975's
grouping rules (how a call finds its step, the open window of two) have nothing
left to group. Its live-region decision (the announcer is the one polite region)
**stands** and is extended below.

**Where a failed or refused call's mark went: it is dropped from the rail.** A
step-level mark would be the call's information without the call: _"this step had a
refused write"_ tells the reader nothing they can act on, and MOTIR-7975 already
ruled a failed lookup is not a failed run. The planner reads the refusal and
carries on, and when it matters, its own next sentence says so in words (_"There
are none left, so this card is not needed."_). Nothing new is stored for it.

**What stays from sheet 3:** the run rows a stream still produces (`submit`,
`reading`, hand-off, notes, `proposed`, the loud `frame: <kind>` row) and their
three-column shape. The stream's `laying` / `authoring` rows are **not** drawn any
more: the session heads replace them, from the store.

### The narration message, beside a reply and a step row (panel 1)

| element                             | shape                                                                                                      | ink                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| reply bubble (shipped)              | avatar + `--el-chat-bubble-ai` bubble, `text-sm`                                                           | `--el-text`                                                  |
| run row (shipped) / step head (new) | glyph · mono label · line, `text-xs`                                                                       | live `--el-text`; finished `--el-text-secondary`             |
| **narration message** (new)         | no avatar, no bubble, no glyph; in an `<ol>` indented under its head's hairline; `text-xs leading-relaxed` | `--el-text-secondary`; the live session's newest `--el-text` |

**Why quieter than a reply.** A reply is the planner speaking **to you**, and it may
ask something. Narration is the planner thinking aloud about its own work. The
reply keeps the bubble so the eye lands on it; narration takes the act record's
size and secondary ink, so a long walk reads as a margin, not a conversation.
**Why no glyph.** The glyph column is the step axis; a glyph per sentence would make
every sentence look like a step.

**The step row survives as the group's head, and so does the mono label column.**
The head is `glyph · KIND · target title`: the kind word is a copy key
(`settle` / `lay` / `author`, translated), the title is the stored target title (not
translated), and a `settle` head, which has no target, reads _Settling what to
change_. The mono column stays the axis a reader skims.

### One group per session (panel 2)

- A group is one planner session (`sessionKey`), headed by that session's stored
  step words. Its messages sit under it in their own order. **A message never sits
  under another session's head.**
- **Groups are ordered by session start** (`firstReportedAt`, then id), never by
  message time. A new message is appended to the end of its own group. Interleaving
  by time reads as a log of crossed voices: three sessions writing at once would
  alternate line by line and the reader would re-assemble each thought from
  scattered lines. MOTIR-7975 rejected the same interleave for call lines, and it
  is worse for sentences, which only make sense after the previous one from the
  same session.
- **A head always names its session's step, live or finished.** A live session's
  head carries the shipped spinner in the glyph slot and `--el-text`. A finished
  session's head carries `circle-check` in the glyph slot and the word **· done**
  after its line, at `--el-text-secondary`. The head keeps the **shipped act line's
  wording** (_Writing <title>_, _Laying out <title>_) rather than a past tense, so
  one catalogue line serves both states and the mark carries the state.
- The live session's newest message takes `--el-text`, as the shipped open step
  did. **No new motion.**
- Measured on the board: the long walk is 12 groups and about 30 message rows. At
  the 1366 × 768 floor (a 648 px rail, MOTIR-7975's measurement) only the opening
  and the first two groups fit above the fold; the transcript scrolls and
  auto-scrolls to the newest message while the reader has not scrolled away, as
  shipped. Collapsed, the same walk is 12 head rows.
- **A long walk's earlier sentences.** The read returns the newest window of
  sentences (`earlierCount` before it). When `earlierCount > 0` the block opens with
  an _N earlier notes_ row (the shipped disclosure button, `chevron-up`); pressing it
  pages the earlier sentences into their own groups, whose heads are already there.

### The collapse-all control (panel 3)

- **Placement: a sticky row at the top of the narration block, inside the
  transcript** (`sticky top-0`, `--el-surface`, full rail width): a mono _planner
  notes_ label and, at the right, the shipped disclosure button. Not the rail
  header: at `22rem` the header already holds the status dot, _MOTIR AI_, the mode
  chip and MOTIR-7647's _Plan something new_ control, and a labelled button with a
  count would wrap; an icon-only one would hide the count. Sticky keeps it in reach
  anywhere inside a long walk, and it scrolls away with the block when later turns
  follow it.
- **Labels.** Every group open: **Hide planner notes (N)**, `chevrons-down-up`,
  `aria-expanded="true"`. Any group folded: **Show planner notes (N)**,
  `chevrons-up-down`, `aria-expanded="false"`. N is the plan's total sentence count
  (the window plus `earlierCount`).
- **A collapsed group** keeps its head row and its own disclosure, **N notes**, so one
  group can be opened alone. The all-control says _Hide_ only when every group is
  open; pressing _Show_ opens all, and a later _Hide_ folds every group again,
  including one opened alone.
- **What it never hides:** the person's own turns, the planner's reply turns (which
  may ask a question), every step head, and the pending question
  (`plan-change-pending-question`). It folds narration messages and nothing else.
- **Remembered per browser, globally:** `localStorage["motir:planning:planner-notes"]`
  = `"collapsed"` | `"expanded"`; absent means expanded. Only the all-control writes
  it; a single group's disclosure is view state and is not remembered. **Global, not
  per plan**, because the request is about the reader (_"it's always the planner
  speaking"_): a per-plan key would open every new plan expanded, which is what
  they asked to stop. It needs no sign-in, so a Visitor gets it too. **No server
  field is drawn.**
- **Zero messages:** the row is not rendered. There is no disabled control.
- **Open question (not drawn):** whether a signed-in person wants the choice to
  follow them across devices, which would need a per-user server preference.

### Display length (panel 4)

- **A message wraps in full and is never clamped.** The store cuts every sentence to
  one line of at most `PLAN_NARRATION_SENTENCE_MAX` (240) code points, four to five
  rows at `22rem`. A clamp would put one more press in front of every long sentence,
  and a tooltip on a plain sentence is not keyboard-reachable. The accessible name
  is the text itself.
- **An unbroken run** (a path, a URL) breaks anywhere (`wrap-anywhere`), as the
  shipped user bubble does.
- **A long head title wraps in full too**, with no ellipsis (`min-w-0 flex-1
wrap-anywhere`). The head is the only place a session is named, and in a folded
  group it is the only row left; cutting it could leave two heads that read the
  same. The group's disclosure stays at the end of the head's first line. The
  running bar keeps its shipped one-line truncation.

### Language (panel 5)

- Copy keys (the kind word, counts, marks, the control) follow the interface
  locale. **A narration sentence is shown as the planner wrote it and is never
  translated**; a target title is the proposal's own title and is not translated.
- **`lang` is omitted.** No field carries a sentence's language, and a wrong guess is
  worse than none: a wrong `lang` makes a screen reader read English with a Chinese
  voice. The message inherits the rail's `lang` (the interface locale). Each message
  and each head title carries **`dir="auto"`**, which costs nothing and keeps a
  right-to-left sentence's punctuation in place.

### The states (panels 6–9)

- **Live, hosted planner** (panels 1–3): messages and heads arrive with each tick of
  the review poll (`useGeneratingPlanPoll`, 2.5 s), not per stream frame. No call
  lines.
- **Live, plan.py** (panel 6): the previously empty MCP rail now holds the same
  groups, under the shipped MCP notice and hand-off.
- **Returned to mid-run** (panel 6): before, the reopened rail showed nothing of the
  run (the user's report, _"then I don't see the tool calls anymore"_). After,
  every message and head is restored by the first review read.
- **A session ending** (panel 7): its group stays, loses live ink, takes
  `circle-check` + **· done**, and keeps its real step words; the others carry on.
- **No sentence yet, or ever** (panel 7): the head shows alone, with no disclosure,
  no empty list, no placeholder and no reserved height.
- **Stalled / reconnecting** (panel 7): nothing on the rail changes, and **the panel
  does not dim**. The messages may be minutes old but are still true; dimming would
  read as withdrawn. Stalled and reconnecting stay where they are shown today (the
  progress line, the canvas live badge).
- **A step naming a withdrawn proposal** (panel 7): the group's history stays,
  because narration is per session, not per proposal. The head reads the step
  words **as stored**, with no strike-through and no withdrawn mark: no field says
  it was withdrawn, and the canvas shows withdrawals. The head is not a link, so
  nothing breaks.
- **A sentence whose session has no step-words row** (a step reported before the
  store existed; panel 7): drawn as a **headless group**, its own hairline list,
  placed before the headed groups. It is never given an invented head.
- **Ended: `planned`, `stale`, `approved`, `declined`** (panel 8): every message
  readable, every head with its real step words and the finished mark, nothing
  live, and the control works exactly as while generating. The status chrome
  around the transcript is shipped and unchanged.
- **Visitor** (panel 9): the same messages and heads, read-only, no composer, and the
  collapse control **remains** (it is a reading control and writes nothing to the
  server). A reader who may not see the plan sees no panel.
- **No narration** (`--no-narrate`, or a planner that wrote none; panel 9): step
  heads only, no collapse row, no group disclosures, no placeholder.
- **Collapsed and expanded** forms of the live (panel 3), ended (panel 8) and
  Visitor (panel 9) frames, with one group opened alone in panels 3 and 8.

### The data each element reads

All from the review read (`GET /api/plans/[id]`), which MOTIR-8063 extends:

| drawn element                   | data                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| a group, its order, its head    | `narration.sessions[]`: `sessionKey`, `stepKind`, `targetTitle`, `firstReportedAt` (then id). `targetRef` is not drawn. |
| a message, its group, its order | `narration.entries[]`: `body`, `sessionKey`, `seq`. `createdAt` is not drawn.                                           |
| _N earlier notes_               | `narration.earlierCount`, then the paged narration read                                                                 |
| live vs finished                | the review read's existing `inFlightSteps[].sessionKey` while the plan is `generating`; every other session is finished |
| the collapse state              | this browser's `localStorage`                                                                                           |

No other field is read or drawn: no sentence language, no per-message mark, no
withdrawn flag.

### Screen readers

- **The announcer stays the only live region.** `plan-change-progress` keeps its
  `sr-only` `plan-change-announcer`; no region is added.
- **Messages are not announced.** The transcript is `role="log"`, which is
  implicitly polite, so anything appended inside it would be spoken. The narration
  block's wrapper (`data-testid="plan-narration"`) carries **`aria-live="off"`**, and
  the nearest ancestor's value applies (WAI-ARIA 1.2, `aria-live`). **Not yet
  verified in a screen reader:** Chromium's accessibility tree (CDP
  `Accessibility.getFullAXTree`, run while drawing this) reports the log as polite
  but exposes no per-descendant live status, so it could not confirm the override.
  **MOTIR-8064 owes a VoiceOver or NVDA pass** on the built panel. If it shows the
  messages are spoken, the fallback is to render the narration block as a sibling
  after the `role="log"` container, which this board does not draw.
- **What the announcer says now:** a session's head line when its group first
  appears or its step words change (_Writing Expire idle sessions server-side_),
  and _{step} — finished_ when it ends. Never a narration sentence, and nothing
  about calls.
- **On-demand reading:** the all-control is a `<button>` named by its visible label
  with the count, with `aria-expanded` and `aria-controls` listing every group's
  message list. Each group disclosure is a `<button>` (_3 notes_) with
  `aria-expanded` and `aria-controls` its list. Each message list is an `<ol>` named
  for its group (`aria-label`: _Writing Move token refresh into SessionStore —
  finished_). Reading order: head, then its messages in order, then the next group.
- Glyphs are `aria-hidden`; the spinner keeps its shipped `role="status"`;
  **· done** is real text.

### Primitives composed

| element           | built from                                                                                                     | colour                                                       | shape                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| narration block   | NEW `<div data-testid="plan-narration" aria-live="off">`                                                       | —                                                            | layout only                                             |
| collapse-all row  | NEW sticky row: mono label + the shipped disclosure button (`chevrons-down-up` / `chevrons-up-down`)           | `--el-surface` row; label `--el-text-secondary`              | `--radius-control`, `--spacing-chip-x/y`, `text-[11px]` |
| group list        | NEW `<ol data-testid="plan-narration-groups">`, the act record's panel                                         | `--el-surface-soft`                                          | `--radius-card`                                         |
| step head         | the shipped act row (glyph · mono label · line), now from the stored step words                                | live `--el-text`; finished `--el-text-secondary`             | as shipped                                              |
| finished mark     | NEW `circle-check` in the glyph slot + **· done** after the line                                               | `--el-text-secondary`                                        | —                                                       |
| group disclosure  | the shipped disclosure button: chevron + _N notes_                                                             | as shipped                                                   | as shipped                                              |
| message list      | NEW `<ol data-testid="plan-narration-messages" aria-label>`, indented under the head (`ml-5.5`), left hairline | `--el-border-strong` hairline                                | layout only                                             |
| narration message | NEW `<li dir="auto" data-testid="plan-narration-message">`, `text-xs leading-relaxed wrap-anywhere`            | `--el-text-secondary`; the live session's newest `--el-text` | —                                                       |

Colour is `--el-*` only and no token was added; `--el-text-secondary` clears AA on
`--el-surface-soft` (6.51:1). Shape is element-semantic tokens only. Every state
pairs a word or a structure with any glyph, so no state rests on colour.

### Copy, en and zh (`planningWorkspace.conversation.narration.*`)

| key             | en                                                              | zh                      |
| --------------- | --------------------------------------------------------------- | ----------------------- |
| `label`         | planner notes                                                   | 规划说明                |
| `hideAll`       | Hide planner notes ({count})                                    | 收起规划说明（{count}） |
| `showAll`       | Show planner notes ({count})                                    | 展开规划说明（{count}） |
| `groupCount`    | `{count, plural, one {# note} other {# notes}}`                 | {count} 条说明          |
| `earlier`       | `{count, plural, one {# earlier note} other {# earlier notes}}` | 更早的 {count} 条说明   |
| `done`          | · done                                                          | · 已完成                |
| `kindSettle`    | settle                                                          | 收束                    |
| `settleLine`    | Settling what to change                                         | 正在确定要改什么        |
| `groupLive`     | {step} — in progress                                            | {step} —— 进行中        |
| `groupFinished` | {step} — finished                                               | {step} —— 已完成        |

Reused, unchanged: `act.laying` / `act.authoring` (the kind words _lay_ / _author_,
_铺层_ / _撰写_) and `act.layingLine` / `act.authoringLine` (the head lines). The
announcer's finished line is `groupFinished`. A narration sentence and a target
title are not copy keys.

**Left unused by this delta** (MOTIR-8064 removes them with the call lines): every
key under `act.call` — `act.call.tool.*` (40 keys), `act.call.family.*` (12),
`act.call.mark.failed` / `.refused` / `.skipped`, `act.call.count`,
`act.call.countFailed`, `act.call.earlier`, `act.call.barParallel`,
`act.call.announceFailed`, `act.call.announceRefused` and `act.call.full.*`.

### Deliverable

`design/ai-chat/plan-change-run-live--narration.mock.html` (the delta mock, panels
1–10) and this section. `prettier --check` is clean, and
`tests/design-ink-contrast.test.ts`, `tests/design-state-ink-contrast.test.ts` and
`tests/design-three-file-set.test.ts` pass on it. It amends sheet 3 and MOTIR-7975's
section, which stay as records. It gates **MOTIR-8064** (the rendering and the en
and zh catalogues).

## 2026-10-12 — the vibe layout in discovery: the lockup in `OnboardingTopBar`, the chat rail's voice, a brand row on the direction-doc page (MOTIR-8251)

**Amends:** the onboarding top bar (the `wz-bar` drawn in [`onboarding.mock.html`](./onboarding.mock.html)
and shipped by MOTIR-1488 as `components/onboarding/OnboardingTopBar.tsx`) — its brand position and its
trailing end — and the onboarding-origin direction-doc page. **Delta mock:**
[`onboarding--vibe-lockup.mock.html`](./onboarding--vibe-lockup.mock.html). `onboarding.mock.html` is a
record and is **not edited**. Story MOTIR-8238; sibling sections:
[`design/onboarding-migrate/design-notes.md` § 2026-10-12](../onboarding-migrate/design-notes.md) and
[`design/import/design-notes.md` § 2026-10-12](../import/design-notes.md).

**Composes, never re-draws:** MOTIR-8250's Pattern panel A (the lockup) —
`design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html` **Panel 6** — and the
language control from `design/auth/auth-frame--language-control.mock.html` (MOTIR-8286's control, in
MOTIR-8250's position: the last control of the bar).

**Design system — files read:** root `package.json`, `app/globals.css` (lines 13 and 25),
`packages/design-system/package.json` (**`0.13.0`**, exports `./mock`), `app/layout.tsx`. No
`DESIGN.md`. **Verdict: ON MOTIR DESIGN — branch (a)**, built with `renderMock` from the package's
`Button`, `Combobox`, `Spinner` and `buttonVariants`, plus `@motir/brand`'s `BrandMark`; axes
`warm-editorial` · `motir` · `motir`, light and dark per frame. Nothing is proposed for the package.

**Shipped reality read** at `origin/main`: `OnboardingTopBar.tsx` (52 px; lavender tile with the AI
glyph + `topbarProject`; the step caption in `--el-accent-on-surface` mono; ghost Save & exit with
`History`), `DiscoveryChatRail.tsx` (header dot + `railLabel`; the avatar is `BrandMark` mark,
inverted, 13 px; `assistantName` is not rendered), `DiscoveryOnboarding.tsx` (grid `1fr_22rem`),
`app/(onboarding)/onboarding/direction/[tier]/page.tsx` (`main`, `bg-(--el-surface)`, `max-w-[60rem]`),
`DirectionDocFullPage.tsx`, `TierDocModal.tsx` and `messages/en.json`. motir.co read at
`motir-marketing` `origin/main` **`06c0411`**.

### Panels (light AND dark)

| #   | Panel                                                                                                     | frame         |
| --- | --------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Discovery canvas + chat rail with the top bar — the one change is the brand position and the trailing end | 1280          |
| 2   | Top-bar strips — 2a with a project name · 2b the fallback ("New project") · 2c revisiting a step          | light \| dark |
| 3   | Language control in the bar — 3a pending · 3b failed · 3c open                                            | light \| dark |
| 4   | Chat rail close-up — header, one assistant turn, composer (voice only; layout unchanged)                  | light \| dark |
| 5   | Access path — the tier-doc modal's "Open full page" (a new tab to `/onboarding/direction/{tier}`)         | 620 × 2       |
| 6   | Direction-doc page, onboarding origin, with a doc — the slim brand row added                              | 1280          |
| 7   | Direction-doc page, the error state                                                                       | 1280          |

### What changes, and what does not

- **`OnboardingTopBar`.** The lavender tile with the AI glyph is TAKEN. The `BrandMark` **lockup** (22
  px, not a link) takes it, then a 1 px `--el-border` divider, then `{project} · new project` (or the
  fallback). Lockup rather than glyph: the glyph alone is the chat rail's assistant avatar, so a
  glyph-only bar reads as "the assistant"; and without the divider the fallback would read "Motir New
  project". The step caption and Save & exit are unchanged; the **language control** joins the trailing
  end, after Save & exit. Height stays 52 px.
- **The chat rail — voice only.** The English voice card (MOTIR-8248) re-worded no `onboarding.chat.*`
  key, so the rail is drawn exactly as shipped: "Chat", the glyph avatar on `--el-accent`, "Reply, or
  ask a question…". No visible assistant name is added. The layout (`1fr_22rem`) is unchanged.
- **The direction-doc page (onboarding origin only).** A slim brand row — the lockup (24 px, not a
  link) and the language control — on the onboarding wrapper `page.tsx`, inside the same
  `max-w-[60rem]` column. **No second Back:** the shared component's own "Back to roadmap" already goes
  to `/onboarding` in this origin. `DirectionDocFullPage` and the in-shell `/direction/[tier]` are
  **unchanged**.
- **Behaviour is unchanged**: Save & exit, the canvas, the rail, the modal's new-tab door, the doc
  page's links and its error state.

### Per-element `--el-*` and shape role

| element                     | colour                                                    | shape / size                         |
| --------------------------- | --------------------------------------------------------- | ------------------------------------ |
| top bar                     | unchanged (`--el-page-bg` ground, `border-b --el-border`) | 52 px                                |
| lockup                      | `brand.css` (glyph + word in `--el-text`)                 | 22 px (bar) · 24 px (doc row)        |
| divider                     | `--el-border`                                             | 1 px × 16 px                         |
| project label               | `--el-text`                                               | 14 px, truncates                     |
| step caption                | `--el-accent-on-surface` mono (unchanged)                 | —                                    |
| Save & exit                 | `Button ghost sm` (unchanged)                             | `--radius-btn`, `--height-btn-sm`    |
| language control            | package `Combobox` trigger                                | `--radius-input`, `--height-control` |
| rail avatar                 | `--el-accent` fill, inverted glyph (unchanged)            | `rounded-full`                       |
| doc brand row               | no fill, no rule, on the page's `--el-surface`            | `py-4`, `max-w-[60rem]`              |
| doc breadcrumb · error body | drawn `--el-text-secondary` (see F3)                      | —                                    |
| focus ring                  | `--el-accent-on-surface`                                  | `ring-2`                             |

### Slot → key

| slot                                                        | key                                                                                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bar label · project · fallback                              | `onboarding.chat.{topbarLabel,topbarProject,topbarProjectFallback}`                                                                                                  |
| step caption                                                | `onboarding.chat.canvas.caption`                                                                                                                                     |
| Save & exit                                                 | `onboarding.chat.saveExit`                                                                                                                                           |
| language control                                            | `auth.language.{label,switching,failed,retry}` + `localeLabel`                                                                                                       |
| rail header · composer · send · drafting                    | `onboarding.chat.{railLabel,composerPlaceholder,send,drafting}`                                                                                                      |
| canvas stations and pills                                   | `onboarding.chat.canvas.*` (unchanged)                                                                                                                               |
| modal "Open full page"                                      | `issueViews.openFullPage` — see F2                                                                                                                                   |
| doc "Back to roadmap" · "Roadmap" · "Direction" · doc title | `publicProjects.requestBackToRoadmap` · `roadmap.canvas.breadcrumbRoot` · `platformAdmin.ideas.kind.direction` · `onboarding.landing.steps.understandTitle` — see F2 |
| doc error copy · "Direction · Discovery" kicker             | **no key** — see F2                                                                                                                                                  |

The chat turn, the idea and the doc body are fixtures, not product copy.

### Findings

- **F1 — the card's premise "Motir AI kept as the assistant's name" is wrong.**
  `onboarding.chat.assistantName` is "Motir" and is not rendered anywhere; the rail shows no name. The
  design keeps it that way.
- **F2 — `DirectionDocFullPage` and `TierDocModal` hard-code English literals** ("Back to roadmap",
  "Roadmap", "Direction", "Couldn't load this doc", "Open full page", …). The mock draws the values
  that match existing keys (listed above) and draws the error copy and the "Direction · Discovery"
  kicker as shipped, flagged as having **no key**. A Chinese E2E (MOTIR-8257) will see English there.
  Moving them onto keys is outside this card; MOTIR-8255 should file it.
- **F3 — the shipped breadcrumb and error body use `--el-text-muted` on the `--el-surface` page**:
  4.17:1, an AA failure today. The mock draws them in `--el-text-secondary`. Because the component is
  shared with the in-shell route, the fix is the component's, not this wrapper's.
- **F4 — MOTIR-8286's premise** assumes the wizard, the importer and the direction-doc page render
  `OnboardingTopBar`; only discovery does. This design gives the other three their own trailing
  language control (the sibling sections and Panel 6 here).
- **F5 — the card asked for a Back in the doc page's brand row.** It is not drawn: the shared
  component's "Back to roadmap" already returns to `/onboarding`, and a second one would be a
  duplicate. This changes MOTIR-8255's criteria.

- **F6 — the working tree already moves on this bar.** MOTIR-8252, building in the same worktree,
  has an uncommitted `OnboardingTopBar.tsx` that swaps the tile for `BrandMark` lockup at **28 px with
  no divider**. This design specifies **22 px plus the 1 px divider** (and the language control): 28
  px is the hero bar's size, the 52 px bar is denser, and the divider is what keeps the fallback from
  reading "Motir New project". Whoever lands the bar (MOTIR-8252 or MOTIR-8255) should reconcile to
  this section.

### Chinese-length risks (for MOTIR-8249 / MOTIR-8258)

`topbarProject` with a long project name (truncates before the caption; the lockup and the controls
never shrink).

### GIVES / TAKES

- **TAKES** the lavender AI-glyph tile from `OnboardingTopBar`.
- **GIVES MOTIR-8255** the build: the bar's lockup + divider + language control, the rail (no change),
  the doc page's brand row, F3 and F5.
- **GIVES MOTIR-8286** the language control in this bar and on the doc page (Panels 3, 6, 7).
- **GIVES MOTIR-8256** the pairs to gate (the lockup on `--el-page-bg`, the doc row on `--el-surface`);
  **MOTIR-8249 / MOTIR-8258** the CJK risk; **MOTIR-8257** the E2E context and F2.
- **Premises taken from** MOTIR-1488, MOTIR-8248 and MOTIR-8250.

### Revision 4 (2026-10-12) — the warm pass

The vibe-layout board in this area takes the warm pass described in `design/onboarding-migrate/design-notes.md` § _Revision 4_: the hero glow and warm waves, the orange step dot, and orange (`--el-highlight`) for the current step, the picked row and the "you are here" marker, with `--el-tint-yellow` behind progress. Every label stays on the ink tokens; the orange is used for fills, rings, borders and glyphs only.

### Revision 5 (2026-10-12) — warm on the button only

The warm pass narrows to the primary button and small marks (the step dot, spinners, progress fills); every surface returns to the cool shipped look. See `design/onboarding-migrate/design-notes.md` § _Revision 5_ for the two new roles (`--el-cta-warm`, `--el-cta-warm-text`) and their measured contrast.

### Revision 6 (2026-10-12) — how this canvas is reached

This board is the discovery canvas for a person who starts from an idea. It is not the migrate wizard's "A few questions", which is now a step of the wizard page (`design/onboarding-migrate/design-notes.md` § _Revision 6_, Panels 6a–6d). The new Panel 0 draws the door: the migrate wizard's bar link **Start from an idea instead** → `/onboarding/discovery`, with its focus ring; the entrance's Start reaches it too. Panel 1's note no longer lists the wizard's Decision and Resume, which now advance in place.

---

## ⭐ Motir at work — the drafted card turns warm orange, pops and breathes, and one Motir mark in the rail breathes with it (MOTIR-8414, 2026-10-14)

**Revised after review (2026-10-14).** The first version breathed only the shipped dotted ring's
opacity, in the in-progress blue. The design gate came back _Request changes_: _"use a different
color on the card to make the drafting more obvious, use the warm orange in default motir style … and
make the card popping and growing a bit with the color."_ So this version:

- gives the drafted card its OWN colour — two new roles, **`--el-drafting`** (Motir: its warm orange,
  the `--color-accent` that `--el-highlight` and `--el-progress-fill` already ride) and
  **`--el-drafting-surface`** (Motir: the warmed peach wash). The card wears the wash, the ring turns
  solid orange, and the chip takes the orange edge and icon. The at-work mark takes the same orange.
- makes the card **pop and grow**: it pops on arrival (scale 1 → 1.06 → 1.02), then breathes between
  1.02 and 1.04 with an orange glow on its ring.

The colour is the static cue, so a reduced-motion reader, a stalled plan and a dropped read all still
see which card is being written. Only the pop, the growth and the glow are motion.

**Design system, identified first.** Read `package.json` (depends on `@motir/design-system`,
`workspace:*`) and `app/globals.css` (line 13, `@import '@motir/design-system/theme.css'`). Both hold,
so the verdict is **(a) ON MOTIR DESIGN**, package **v0.14.0** (`packages/design-system/package.json`).
The project's axes are per person (`app/layout.tsx` stamps the reader's `data-style` / `data-palette`
/ `data-type`; a signed-out reader gets none), so the board renders at the package defaults
(`warm-editorial` · `motir` · `motir`), which is what a Visitor sees. The package exports
`@motir/design-system/mock`, and the board is built with its `renderMock`. Every part on this surface
is product-local, so the board composes those parts' **real emitted markup**:

| part                                                                  | kind                    | reason                                                               |
| --------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `PlanProposalViews` → `PlanReviewCanvas` → `PlanningCanvas` cue layer | product-local component | the planning canvas and its one cue layer                            |
| `PlanProgressLineView` (the pane header's marker and line)            | product-local component | the plan's progress line, cited and not changed                      |
| `PlanChangeRail` (header, narration block, composer)                  | product-local component | the planning rail                                                    |
| `BrandMark` (`@motir/brand`, re-exported by `components/brand`)       | brand package part      | the mark this section moves; `@motir/brand` is not the design system |

Two tokens are proposed for `@motir/design-system`'s `theme.css` Tier 3 (below). Everything else is a canvas rule beside the shipped cue, and the mark's breath is a rule on a product-local wrapper.

**Amends, on the record:** `design/ai-planning/design-notes.md` **Part XXVI §26.6** (_"It does NOT
loop"_) and **§26.8** rows **C2**, **C8** and **C10**, for the drafting cue only (details below), and
`planning-workspace.mock.html` (the overlay, MOTIR-4726) by adding one element to its rail header.
Neither mock is edited. Story **MOTIR-8413**; **MOTIR-8415** supplies the state, **MOTIR-8416** builds
the card's motion and **MOTIR-8417** the mark's.

**Asset:** [`planning-workspace--at-work.mock.html`](./planning-workspace--at-work.mock.html), a
**delta** holding only the panels that change.

| Panel | What it shows                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| 1     | The overlay at work: the canvas pane, its unchanged progress line, the rail with the ONE added mark        |
| 2     | The pop and the breath, frame by frame (rest · 1.06 · 1.04 + glow · 1.02, then live), and the mark's glyph |
| 3     | Every state, card and mark (the table below, drawn row by row)                                             |
| 4     | Several cards named at once, each orange and breathing on its own, with the shipped off-level count        |
| 5     | A cued card that deepens: the accent outline inside the orange ring                                        |
| 6     | The leaving form, for a step that moves on and for a plan that stops being `generating`                    |
| 7     | An exiting node — no cue                                                                                   |
| 8     | Panel 3 again under `prefers-reduced-motion: reduce`                                                       |
| 9–11  | Panels 1, 3 and 8 in dark (a nested `data-theme="dark" data-appearance-scope` frame, so the tokens flip)   |

### Rendered before drawn

Every canvas pane and the rail are the emitted markup of `PlanProposalViews` and `PlanChangeRail` at
motir-core `9b538d7d5`, captured with `tests/helpers/renderWithIntl` → `container.innerHTML` (en), one
capture per progress state (starting, working with one and with several steps, writing, stalled,
failing, resuming, off-level, settled). The delta is applied to those captures and to nothing else:
one attribute on the shipped node box, one wrapped `BrandMark` in the rail header, two tokens and
the rules below. Two board-only liberties, both labelled in the stylesheet: the canvas world is offset and
scaled to 0.9 (the shipped canvas fits itself to the pane in a browser, which a static capture cannot
measure), and panel 8 switches animations off to stand for the media query. What the render showed:

- **Today the cue VANISHES on a stall.** `readPlanProgress` returns `liveSteps: []` when the plan is
  stalled, so the shipped canvas drops every cue the moment the 15-minute threshold passes (the
  stalled capture has no `data-cue`). This section changes that (the stalled row below).
- **The rail header carries no mark.** It is a status dot, the `planningWorkspace.railLabel` word
  (_Motir AI_) and the mode pill. The marks in the rail are the 13 px inverted glyphs inside each
  assistant message's avatar disc, one per message.
- **`PlanProgressState` has FIVE values on `main`, not four.** MOTIR-8309 added `resuming`
  (`lib/plans/planProgress.ts`, Part XXVII). The table below covers it; MOTIR-8415's precedence
  needs the same row.
- **The cue's design of record is reachable.** The card was written when `Part XXV §25.6–25.8` in
  `design/ai-planning/design-notes.md` resolved to the approve-progress design and
  `plan-review--live-progress.mock.html` was missing. MOTIR-8299 has since landed the cue's design as
  **Part XXVI**, with that mock, and the shipped comment in `app/globals.css` cites Part XXVI. No
  dangling citation was reproduced, so no bug was filed for it.

### The number of this section

`design/ai-chat/design-notes.md` has **no numbered Parts**: its sections are `## ⭐ <title> (KEY,
date)` headings, and its index is those headings. So this section takes no number, and its address is
its heading. Checked on 2026-10-14 against the file's headings (`grep -n "^## " design-notes.md`: no
heading names _at work_) and against the area's published results (`list_designs { projectKey:
"MOTIR", pathPrefix: "design/ai-chat/planning-workspace" }`: 18 results, none holding an `--at-work`
mock or a section of this title).

### The States table — total, card and mark

The CARD answers _which_ card Motir is writing; the MARK answers _that_ Motir is at work. Both read
one datum, MOTIR-8415's at-work state over the shipped reading.

| state (where it comes from)                                                                       | the card — the cue layer on the node box                                                                                                                                                     | the Motir mark — rail header                            | reduced motion                                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `starting` — a settle step, nothing proposed (`readPlanProgress`)                                 | no card is cued (none exists to name); nothing moves                                                                                                                                         | **breathes**                                            | no cue; the mark is the static glyph                                      |
| `working`, one live step naming a card                                                            | that card turns **orange**, **pops** and **breathes** (grows, ring glows); every other card on the level is still                                                                            | **breathes**                                            | the orange static cue on that card, at rest size; the orange glyph, still |
| `working`, several live steps                                                                     | each named card is orange and breathes **on its own** — its pop and breath start when its own cue arrives; nothing synchronises them and nothing staggers them                               | **breathes** — ONE instance                             | each named card holds the orange static cue; one orange glyph, still      |
| `working`, a step on a level the reader is not viewing                                            | the named card is orange and breathes wherever the one layer renders it; on the viewed level the shipped arrivals slot says _{count} being drafted in {identifier} · Go there_               | **breathes**                                            | the static cue where rendered; the slot's words; the static glyph         |
| `writing` — proposals exist, no live step                                                         | no card is cued; nothing moves                                                                                                                                                               | **breathes**                                            | no cue; the static glyph                                                  |
| `stalled` — quiet past `PLAN_STALLED_AFTER_MS` (15 min)                                           | the card the snapshot's steps last named keeps the **orange static** cue at rest size — no pop, no growth, no glow, and it does not vanish                                                   | **static** — the shipped glyph at full opacity          | the same orange static cue; the static glyph                              |
| `reconnecting` — the poll is `failing` (three failed reads)                                       | the card the held step names keeps the **orange static** cue at rest size (the last snapshot stands)                                                                                         | **static**                                              | the same; the static glyph                                                |
| `resuming` — Motir resumed the plan by itself and the new job has not yet spoken                  | no card is cued (the resume drops the lost machine's steps); nothing moves                                                                                                                   | **static** — nothing has been reported since the resume | no cue; the static glyph                                                  |
| `settled` — the plan left `generating` (planned, approved, declined, or its producer judged dead) | every cue **LEAVES**: ring and chip fade out, the wash fades off and the box settles to scale 1, then the card is its shipped box with its own op fill                                       | **static**, until the overlay hands over                | the cue is removed at the next paint; the static glyph                    |
| a cue whose step moves on or clears (while still `generating`)                                    | that cue **LEAVES** the same way; a new card's cue arrives by the shipped C1                                                                                                                 | unchanged by this event — the state decides             | removed at the next paint                                                 |
| a cued card that DEEPENS                                                                          | both: the deepen's 2 px accent outline (offset 2 px) inside the orange ring (offset 7 px), growing with the box; the **deepen is the fresher signal** (news) and does not restart the breath | —                                                       | §23.5's static deepen inside the orange static ring                       |
| an exiting node (a proposal withdrawn)                                                            | no cue — a withdrawn target is dropped from the steps, so the shipped layer adds none and this delta adds none                                                                               | —                                                       | no cue                                                                    |

**Why stalled and reconnecting HOLD and do not leave.** A person must still see which card was being
written when the producer went quiet, and both states can recover. The orange cue at rest size states a
fact; only the pop, the growth and the glow claim liveness, and they are what stop. **Why `resuming` does not move the mark,
when `starting` does:** `starting` follows a request a person just made; `resuming` follows a lost
machine, and until the new job reports anything the honest form is still. The progress line's
_Resuming_ words (Part XXVII) carry the state.

### The colour — the static cue, two new roles

| element              | before (shipped)                                       | now                                                                               |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| the drafted **card** | its op fill (an add card: `--el-tint-lavender`)        | `--el-drafting-surface`, painted as an inset shadow over the op fill              |
| the cue's **ring**   | 2 px dotted `--el-status-in-progress`                  | 2 px **solid** `--el-drafting`                                                    |
| the cue's **chip**   | `--el-card` fill, `--el-status-in-progress` edge + pen | `--el-drafting-surface` fill, `--el-drafting` edge + pen, `--el-text-strong` word |
| the at-work **mark** | `--el-accent-on-surface`                               | `--el-drafting` while at work; the shipped ink otherwise                          |

**The two tokens**, added to `theme.css` Tier 3 beside `--el-progress-fill`, and overridden per
palette the same way:

| token                   | base (every palette)           | `[data-palette='motir']` light / dark                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `--el-drafting`         | `var(--el-status-in-progress)` | `var(--color-accent)` — `#d66000` / `#fa5500`, the warm orange      |
| `--el-drafting-surface` | `var(--el-tint-sky)`           | `var(--color-tint-peach)` — `#fde0c8` / `#36230f`, the warmed peach |

So every other palette keeps today's in-progress hue and gets a matching wash, and Motir gets its
warm orange (`docs/palettes/motir.md` § _Warm touches_). They are new ROLES rather than reuses of
`--el-highlight` and `--el-tint-peach` so a palette can move the drafting colour without moving its
decorative accent, the Epic type or its washes. The board declares them on its own appearance scopes
with Motir's values.

**Why the wash is an inset shadow.** It sits above the card's op fill and below its content, so no
Part VI class is edited, and it can fade out on leave (a shadow animates; swapping a fill class does
not). The op stays legible on a drafted card by its badge (_add_ · _change_ · …) and its border style.

**Contrast, from the palette doc's values (the peach pairs computed from its hexes).** The orange ring and pen are graphics (3:1): ≥3.08:1
on every light surface, ≥4.77:1 on every dark one. The card's `--el-text` title and the chip's
`--el-text-strong` word stay above 13:1 on the peach; the card's `--el-text-secondary` key is about
5.4:1 on the light peach and above 7:1 on the dark one.

### The motion — on the node box, the shipped tokens

| element              | animates                                                           | from → to                                    | duration                                                                   | easing                     | stops when                                                                                  |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| the **node box**     | `scale` (the independent property)                                 | **pop** 1 → 1.06 → 1.02, once                | `var(--transition-slow)`                                                   | `var(--canvas-ease-enter)` | it is a one-shot, on arrival                                                                |
| the **node box**     | `scale`                                                            | **breath** 1.02 → 1.04, `infinite alternate` | `calc(var(--transition-slow) * 6)`, after a `var(--transition-slow)` delay | `ease-in-out`              | the at-work state is not `starting` · `working` · `writing`, or the card is no longer named |
| the cue's **ring**   | `box-shadow` (its orange glow)                                     | 0 → 4 px at 35 %, in phase with the breath   | `calc(var(--transition-slow) * 6)`, same delay                             | `ease-in-out`              | the same                                                                                    |
| the cue's **chip**   | nothing of its own                                                 | it grows with the box                        | —                                                                          | —                          | — (its word stays readable)                                                                 |
| the cue **leaving**  | box `scale` → 1; ring + chip `opacity` → 0; the wash → transparent | then removed                                 | `var(--transition-duration)`                                               | `var(--canvas-ease-exit)`  | it is a one-shot (§26.8 C2's tokens)                                                        |
| the **mark's glyph** | `opacity`                                                          | 1 → 0.55, `infinite alternate`               | `calc(var(--transition-slow) * 6)`                                         | `ease-in-out`              | the at-work state is not `starting` · `working` · `writing`                                 |

**Why `scale`, not `transform`.** The canvas routes its edges from node rects, and a transform on the
box would move what they are measured from. The independent `scale` property composes with any
transform the canvas sets, grows the box about its centre, and leaves `left` / `top`, the edges and
every neighbour where they are; 4 % on a 280 px card is 11 px, inside the canvas's gaps. It is the
first scale the cue uses after its arrival, so it is gated exactly as the rest of the motion.

**The duration, corrected by looking.** The card proposed the bare `var(--transition-slow)`. That is
250 ms (160 ms under one style), so a full breath would take half a second and reads as a flicker.
Six of the same token (1.5 s each way) reads as breathing at real size. The pop keeps the bare token,
because an arrival should be quick. Both are the SHIPPED token, so they follow a `[data-style]` that
re-paces the canvas. The breath's `ease-in-out` is the one easing added: a symmetric breath on the
decelerating enter curve snaps at each turn. The pop keeps `--canvas-ease-enter`.

No rotation and no scale on the mark: the product's rotation idiom is `Spinner`, and a turning
wordmark reads as loading.

**The rules, as they will stand beside the shipped cue in `app/globals.css`** (the two tokens go in
`theme.css`):

```css
.canvas-node--drafting > .canvas-cue-ring {
  border: 2px solid var(--el-drafting);
}
.canvas-node--drafting > .canvas-cue-chip {
  border-color: var(--el-drafting);
  background: var(--el-drafting-surface);
  color: var(--el-text-strong);
}
.canvas-node--drafting > .canvas-cue-chip > svg {
  color: var(--el-drafting);
}
.canvas-node--drafting [data-testid='plan-item-node'] {
  box-shadow:
    inset 0 0 0 100vmax var(--el-drafting-surface),
    var(--shadow-card);
}
.plan-at-work-mark[data-at-work='true'] > .brand-glyph {
  color: var(--el-drafting);
}
@keyframes canvas-cue-pop {
  0% {
    scale: 1;
  }
  60% {
    scale: 1.06;
  }
  100% {
    scale: 1.02;
  }
}
@keyframes canvas-cue-grow {
  from {
    scale: 1.02;
  }
  to {
    scale: 1.04;
  }
}
@keyframes canvas-cue-glow {
  from {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--el-drafting) 0%, transparent);
  }
  to {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--el-drafting) 35%, transparent);
  }
}
@keyframes canvas-cue-settle {
  to {
    scale: 1;
  }
}
@keyframes canvas-cue-wash-out {
  to {
    box-shadow:
      inset 0 0 0 100vmax color-mix(in srgb, var(--el-drafting-surface) 0%, transparent),
      var(--shadow-card);
  }
}
@keyframes canvas-cue-breathe {
  to {
    opacity: 0.55;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .canvas-node--drafting[data-cue-motion='at-work'] {
    animation:
      canvas-cue-pop var(--transition-slow) var(--canvas-ease-enter) both,
      canvas-cue-grow calc(var(--transition-slow) * 6) ease-in-out var(--transition-slow) infinite
        alternate;
  }
  .canvas-node--drafting[data-cue-motion='at-work'] > .canvas-cue-ring {
    animation:
      canvas-cue-ring-enter var(--transition-slow) var(--canvas-ease-enter) both,
      canvas-cue-glow calc(var(--transition-slow) * 6) ease-in-out var(--transition-slow) infinite
        alternate;
  }
  .canvas-node--drafting[data-cue-motion='leaving'] {
    animation: canvas-cue-settle var(--transition-duration) var(--canvas-ease-exit) forwards;
  }
  .canvas-node--drafting[data-cue-motion='leaving'] > .canvas-cue-ring,
  .canvas-node--drafting[data-cue-motion='leaving'] > .canvas-cue-chip {
    animation: canvas-fade-out var(--transition-duration) var(--canvas-ease-exit) forwards;
  }
  .canvas-node--drafting[data-cue-motion='leaving'] [data-testid='plan-item-node'] {
    animation: canvas-cue-wash-out var(--transition-duration) var(--canvas-ease-exit) forwards;
  }
  .plan-at-work-mark[data-at-work='true'] > .brand-glyph {
    animation: canvas-cue-breathe calc(var(--transition-slow) * 6) ease-in-out infinite alternate;
  }
}
@media (prefers-reduced-motion: reduce) {
  .canvas-node--drafting[data-cue-motion='leaving'] > .canvas-cue-ring,
  .canvas-node--drafting[data-cue-motion='leaving'] > .canvas-cue-chip {
    display: none;
  }
  .canvas-node--drafting[data-cue-motion='leaving'] [data-testid='plan-item-node'] {
    box-shadow: var(--shadow-card);
  }
}
```

So the colour lives on the shipped cue's own ring and chip and on the card, and the motion on the
shipped node box, switched by ONE attribute on it — `data-cue-motion="at-work"` while the card is named and Motir is at work, `"leaving"` for
the exit, absent for the static form. There is no second cue layer. The LAYING cue keeps its shipped
treatment: no rule above names `.canvas-node--laying`.

### Where the mark sits

**ONE instance, in the rail header** (`PlanChangeRail`'s `<aside>`, the first row: `flex items-center
gap-2 border-b border-(--el-border-soft) px-4 py-3`), **between the header's status dot and its
_Motir AI_ label**. The header carries no mark today, so the instance is ADDED there; no existing mark
moves, and the avatar glyphs stay still. The markup:

```tsx
<span className="plan-at-work-mark inline-flex shrink-0" data-at-work={atWork} aria-hidden="true">
  <BrandMark variant="mark" size={14} />
</span>
```

Not per narration group (several live steps would multiply it) and not on the canvas pane (its header
slot is the progress line's). Its two neighbours are drawn in panel 1 and are NOT touched: the
narration block with its _Hide planner notes (n)_ control (MOTIR-8060) below it, and the progress
line's marker (_Being written_, MOTIR-7820) in the canvas pane header, which is not this mark.

### Token roles

| element        | colour                                                                                                   | shape                                            |
| -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| drafted card   | `--el-drafting-surface` wash over its op fill; its op badge, border and text unchanged                   | shipped                                          |
| cue ring       | `--el-drafting`, 2 px solid; its glow a `color-mix` of `--el-drafting`                                   | `calc(var(--radius-card) + 7px)` (shipped)       |
| cue chip       | `--el-drafting-surface` fill, `--el-drafting` border + glyph, `--el-text-strong` word                    | `--radius-badge`, `--spacing-chip-x/y` (shipped) |
| the mark       | `--el-drafting` while at work; `--el-accent-on-surface` otherwise (`brand.css`'s `.brand-glyph`)         | 14 px glyph box                                  |
| deepen outline | `--el-accent-on-surface` (shipped)                                                                       | 2 px solid, offset 2 px (shipped)                |
| motion         | `--transition-slow`, `--transition-duration`, `--canvas-ease-enter`, `--canvas-ease-exit`, `ease-in-out` | —                                                |

No raw colour. Two new tokens, `--el-drafting` and `--el-drafting-surface`, and one easing keyword.

### Accessibility

- **The mark stays decorative.** The wrapper is `aria-hidden`, `BrandMark`'s glyph is already
  `aria-hidden`, and it emits no label. The rail's name stays its `aria-label` (_Motir AI_).
- **The cue's chip stays the accessible description** (`role="img"`, _Being drafted now_, tied to the
  box by `aria-describedby`), at every state in which the cue is drawn, moving or not.
- **The rail's one polite live region is untouched**, and so is the progress line's `role="status"`
  marker. Nothing here announces anything.
- **Motion is opt-in**: every animation sits behind `prefers-reduced-motion: no-preference`, and the
  static form is the default. The breath is slow (3 s a cycle) and never flashes (well under the
  WCAG 2.3.1 three-per-second bound). The colour is not motion and is drawn under both settings,
  so the cue never depends on movement to be seen.

### Copy — a decision: no string is added

The words already ship and are cited, not duplicated: the chip's `planReview.cue.drafting`
(_Drafting_ / 起草中) and its name `planReview.cue.draftingName` (_Being drafted now_ / 正在起草); the
marker's `planReview.liveWriting` / `liveStalled` and the line's reconnecting and resuming words
(MOTIR-7820, MOTIR-8309); the rail label `planningWorkspace.railLabel`. The mark carries no text. So
the story's en + zh criterion holds with no new key.

### GIVES / TAKES

- **MOTIR-8413** (the story) — neither; the container.
- **MOTIR-8415** (the at-work state) — **GIVES** the state this section draws. **TAKES** the
  `resuming` row (`atWork` false, `steps` empty) beside its four listed values, so its
  `Record<PlanAtWorkState, boolean>` is total over the five shipped values plus `settled` and
  `reconnecting`.
- **MOTIR-8416** (the card's motion) — **TAKES** the two tokens (`theme.css`, base and Motir), the
  card column, the colour and motion tables, the rules above,
  the `data-cue-motion` attribute, the leaving form, and the stalled hold: under `stalled` the static
  cue names the card the snapshot's steps last named, which `readPlanProgress` no longer hands over in
  `liveSteps`, so the hold is read from the held snapshot, never re-derived.
- **MOTIR-8417** (the mark) — **TAKES** the mark column, its orange ink while at work, the
  placement and markup above, and the accessibility rules.
- **MOTIR-8418** (the coverage and integration gate) — **TAKES** the guards' subjects: one cue layer
  (one attribute, no second element), the four motion tokens, two easings and `ease-in-out` as the
  only vocabulary, the two new colour roles and no raw colour, no new dependency, no new copy key.
- **MOTIR-8419** (the E2E) — **TAKES** the observable hooks: `data-cue-motion` on `[data-node-id]`,
  `data-testid="plan-at-work-mark"` with `data-at-work`, and the states to walk.
- **MOTIR-7820 / MOTIR-7821 / MOTIR-7830** — **GIVE** the cue, the progress line and its marker, the
  off-level wording; this section amends Part XXVI §26.6 and §26.8 C2 / C8 / C10 for the drafting cue
  and changes no word.
- **MOTIR-8060** (the narration) and **MOTIR-7974** (the rail's lines) — **GIVE** the rail this sits
  in; neither changes.
- **MOTIR-6297 / MOTIR-6294 / MOTIR-6300** — **GIVE** the canvas motion, its tokens and its opt-in;
  untouched.
- **MOTIR-6158** — whether a card ARRIVES with motion stays its own.
- **MOTIR-6155** (List | Canvas), **MOTIR-6248** (the resizable split), **MOTIR-5246** (approve
  progress) — neither.
- **MOTIR-8128** — **GIVES** the dead-producer judgement on the same 15 minutes: `stalled` while a
  snapshot is still handed over, `settled` once it is not.

### Part XXVI, amended for the drafting cue

- **§26.6 "It does NOT loop" → it breathes while Motir is at work.** Reason 2 (a loop runs on the
  client's clock) is answered by the gate: the breath runs only while MOTIR-8415 says Motir is at
  work, and stops on stall, on a failing poll and on resume. Reason 3 (the deepen is the motion) is
  kept by making the breath slow and small (2 %), and the deepen the fresher signal. Reason 4
  (reduced motion needs no second design) still holds: the static form is the shipped one.
- **§26.8 C2** (a cue leaves on `--transition-duration` / exit) was specified and never shipped; it is
  now drawn and specified as the `leaving` form.
- **§26.8 C8** (cues leave on stall) → the cue **holds its orange static form** on stall.
- **§26.6's colour** (the in-progress hue, dotted) → the drafting cue takes `--el-drafting`, solid,
  and the card takes `--el-drafting-surface`. The LAYING cue keeps the shipped in-progress dotted form.
- **§26.8 C10** (hand-over: cues gone in one frame) → the drafting cue **leaves by C2**; everything
  else in C10 is unchanged.

### What this section does not draw

- Any motion for the LAYING cue or the crumb chip; the progress line, its marker dot and its words;
  the narration block, its control and the per-call lines; the arrival, exit, glide, edge and deepen
  motion; the counts; the mark's other homes (onboarding, landing, the AI callout orb, the avatar
  discs).
- Any implementation: no component, hook or stylesheet is changed by this card.
- A cue in the List view (still none, §26.18).
- A new door: the overlay is opened exactly as `planning-workspace.mock.html` draws.

## ⭐ The guide's re-plan offer — the wrong-card turn, Confirm and Decline, and the planning Confirm opens (MOTIR-8686, 2026-10-15)

**Story MOTIR-8684. A DELTA.** It amends the shipped **Guide me through** rail (MOTIR-7462's published result, with the deltas of MOTIR-7482 and MOTIR-7810) and composes the SENT seed of `planning-workspace--pick-seed.mock.html` revision 3 (§ _The picked option planned_) and the running bar of `plan-change-run-live.mock.html` state A. It edits none of them. The mock is **`design/ai-chat/guide-replan-offer.mock.html`**; its stylesheet is lifted verbatim from the pick-seed mock with a token-only `.ro-*` block appended. The behaviour drawn is the decision MOTIR-8685 (published as a Motir page; it amends A3.9 (b) of `docs/decisions/guide-turn-files.md`), its table _The target-wrong verdict, in full after this decision_; this section invents none. The access path is the shipped one (`?plan=guide&planFrom=guide&planItem=<KEY>` from the card's door or the Waiting-on-you row); no door is drawn.

### What changes, in one sentence

The guide's wrong-card turn used to end in a bare stop (a comment on the card). It now ends in an **offer block**: the request the guide wrote, the target it chose, **Confirm** and **Decline**. A wrong _step_ is still corrected in place with no offer (sheet 8, drawn once for contrast).

### The states (the mock's sheets)

1. **Undecided** — the guide's plain-words message (_{KEY} is wrong, so I can't guide you any further._ plus the reason), no step card. Under it the offer block: label, the request in full (clamped with _Show all_ when long), the target as a work-item chip with a one-line note when it is not the guided card, **Confirm** (primary), **Decline** (secondary), and one line saying what each does. Confirm's line says it **sends the request and spends credits**. The canvas keeps the list, the current step no longer marked, and a quiet note that the walk is stopped. The composer stays usable.
2. **Revised / resolved forward / no target** — a newer offer collapses the earlier one to _Replaced by a newer offer_ with no buttons; only the latest offer has Confirm. A done or cancelled target shows the nearest not-done ancestor and says why. When every ancestor is done the offer shows the request and the line, has **no Confirm**, keeps Decline.
3. **Confirming / confirmed / confirmed on an open session** — the wait is on the button only (spinner, disabled, Decline disabled). Confirmed reads **Re-plan started**, who and when, and links _Open the planning session_ (returns, sends nothing). When a session is already open on the target the button is **Open the planning session** from the start and the confirmed state links to the same one.
4. **Declined / resumed** — **Declined**, who and when, no buttons; the rail's existing _Recorded on the card_ line; a line that Guide me through resumes at step N. Pressed again, the rail picks up at the first unticked step with the declined offer above it.
5. **Cannot plan / out of credits** — no `ai:plan` and Motir AI not configured each get their own line and **no Confirm** (Decline stays). Out of credits composes the shipped paywall (`AiPaywall triggeredOutOfCredits`) in the rail's own slot; nothing starts and the offer stays undecided.
6. **Reload** — one conversation with a replaced, a declined and a confirmed offer, in order, light and dark. Each renders from the record alone.
7. **Dark, and the narrow fall-back** — the undecided, confirmed and declined offers in dark; the undecided offer at the rail floor (`--rail-floor`, 352px).
8. **Stale step, for contrast** — unchanged shipped behaviour.
9. **What Confirm opens** — see below.

### Primitives and tokens, per element

| Element              | Primitive                          | Colour                                                                                    | Shape                                     |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| Offer block          | `Card`-like panel                  | `--el-surface` fill, `--el-border`; quiet (decided/replaced) `--el-surface-soft`          | `--radius-card`, `--spacing-card-padding` |
| Label                | caption                            | `--el-text-secondary`                                                                     | —                                         |
| Request text         | quoted panel                       | `--el-surface-soft` fill, `--el-border-soft`, ink `--el-text` / `--el-text-strong`        | `--radius-input`, `--spacing-input-x`     |
| Target chip          | shipped item-link chip             | `--el-chip-bg`, `--el-chip-border`, `--el-text`, title `--el-text-secondary`              | `--radius-badge`, `--spacing-chip-x/y`    |
| Notes and help lines | caption                            | `--el-text-secondary` (never `--el-text-muted` on a surface, never `--el-text-faint`)     | —                                         |
| Confirm / Decline    | `Button` primary / secondary, `sm` | the shipped variants                                                                      | `--radius-btn`, `--height-btn-sm`         |
| Decided state        | `Pill`                             | `--el-tint-mint` for Re-plan started, `--el-chip-bg` for Declined; ink `--el-text-strong` | `--radius-badge`                          |
| Cannot-plan line     | callout                            | `--el-text`, left rule `--el-border-strong`                                               | —                                         |
| Paywall              | the shipped `AiPaywall`            | `--el-tint-rose`, `--el-text-strong`                                                      | `--radius-card`                           |
| Canvas strip         | list                               | `--el-surface-soft`, tick `--el-success`, current step `--el-tint-yellow`                 | `--radius-control`                        |

No raw hue, no `--color-*`, no `--el-danger-text`. The appearance of the offer is a 160 ms fade and 4 px rise; under `prefers-reduced-motion` it is simply present (the end state). Keyboard focus order is: request's _Show all_ → **Confirm** → **Decline** → the composer; both buttons take the shipped focus ring.

### What Confirm opens (sheet 9)

The planner, STARTED on the target, with the guide's request already **sent** as turn 1: the opener lead, a pinned **From a guide** card (the guided card's key and title, a `Planning` status pill in `--el-tint-lavender`, who confirmed and when), the sent bubble, the _Sent to Motir AI_ marker, the act rows and the running bar (`Stop`); then, once answered, the planner's first answer with the composer idle. The mode chip reads **from a guide** (never _in context_, never _plan change_). **No pre-filled unsent composer and no Send step.** The guided card's status reads **Planning** wherever the started surface shows it (canvas node, anchor chip); the plan's card hold (MOTIR-6017) is what keeps it there.

### Copy (en + zh) and who owns the keys

| Key                        | en                                                                                     | zh                                                             | Owner         |
| -------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------- |
| `guide.offer.label`        | Re-plan request                                                                        | 重新规划请求                                                   | rail card     |
| `guide.offer.stop`         | {KEY} is wrong, so I can’t guide you any further.                                      | {KEY} 本身有问题，我没法继续带你往下做了。                     | rail card     |
| `guide.offer.target`       | Aimed at                                                                               | 目标                                                           | rail card     |
| `guide.offer.targetParent` | Its parent, {KEY}, because {why}.                                                      | 它的上级 {KEY}，因为{why}。                                    | rail card     |
| `guide.offer.resolved`     | {DONE} is done, so the re-plan starts on {OPEN}.                                       | {DONE} 已完成，所以重新规划从 {OPEN} 开始。                    | rail card     |
| `guide.offer.noTarget`     | There is no open work item to re-plan from.                                            | 没有可以作为起点的未完成工作项。                               | rail card     |
| `guide.offer.confirm`      | Confirm                                                                                | 确认                                                           | rail card     |
| `guide.offer.confirming`   | Starting…                                                                              | 正在开始…                                                      | rail card     |
| `guide.offer.openSession`  | Open the planning session                                                              | 打开规划会话                                                   | rail card     |
| `guide.offer.decline`      | Decline                                                                                | 拒绝                                                           | rail card     |
| `guide.offer.showAll`      | Show all                                                                               | 展开全部                                                       | rail card     |
| `guide.offer.confirmHelp`  | Opens Motir AI planning on {KEY} with this request sent. It spends credits.            | 在 {KEY} 上打开 Motir AI 规划，并发送此请求。会消耗额度。      | rail card     |
| `guide.offer.declineHelp`  | Closes this offer. Nothing is planned.                                                 | 关闭此提议，不会规划任何内容。                                 | rail card     |
| `guide.offer.replaced`     | Replaced by a newer offer                                                              | 已被更新的提议取代                                             | rail card     |
| `guide.offer.started`      | Re-plan started                                                                        | 已开始重新规划                                                 | rail card     |
| `guide.offer.startedBy`    | Confirmed by {WHO} · {WHEN}                                                            | 由 {WHO} 确认 · {WHEN}                                         | rail card     |
| `guide.offer.declined`     | Declined                                                                               | 已拒绝                                                         | rail card     |
| `guide.offer.declinedBy`   | Declined by {WHO} · {WHEN}                                                             | 由 {WHO} 拒绝 · {WHEN}                                         | rail card     |
| `guide.offer.recorded`     | Recorded on the card                                                                   | 已记录在卡片上                                                 | rail card     |
| `guide.offer.resumeAt`     | Guide me through will pick up at step {N}.                                             | 再次点击“带我完成”会从第 {N} 步继续。                          | rail card     |
| `guide.offer.walkStopped`  | The walk is stopped.                                                                   | 引导已停止。                                                   | rail card     |
| `guide.offer.cannotPlan`   | You can’t start planning here — ask someone who can, or share this request.            | 你无法在这里开始规划——请联系有权限的人，或把此请求分享给他们。 | rail card     |
| `guide.offer.noAi`         | Motir AI isn’t set up here, so planning can’t start. You can still share this request. | 这里还没有配置 Motir AI，无法开始规划。你仍可以分享此请求。    | rail card     |
| `guide.started.chip`       | from a guide                                                                           | 来自引导                                                       | overlay start |
| `guide.started.lead`       | Opened on {TARGET} from Motir AI’s guide on {GUIDED}.                                  | 已在 {TARGET} 上打开，来自 Motir AI 对 {GUIDED} 的引导。       | overlay start |
| `guide.started.card`       | From a guide                                                                           | 来自引导                                                       | overlay start |
| `guide.started.cardBy`     | Confirmed by {WHO} · {WHEN}                                                            | 由 {WHO} 确认 · {WHEN}                                         | overlay start |

The rail card ([MOTIR-8694](motir:cmv9rgb2x0012hvoitmc5h93e)) owns the `guide.offer.*` keys; the overlay start ([MOTIR-8693](motir:cmv9rgb1r0010hvoicrs2f58w)) owns the `guide.started.*` keys. The request text itself is **data the guide wrote**, never catalogue copy.

### Cites

The decision MOTIR-8685, its table by concern: **the turn** and **the offer** (sheet 1), **revision** (sheet 2), **a finished target** (sheet 2: resolved forward, no target), **Confirm** (sheets 3 and 9: sent once, spends credits), **Decline** (sheet 4: nothing planned, no gate decided), **coming back** (sheets 3, 4 and 6: the confirmed link, the open-session case, resume after Decline), **cannot plan** (sheet 5), **the card's status** (sheet 9: Planning only on Confirm), **reload** (sheet 6), and the **trigger** (sheet 8, a stale step, unchanged). Composes: MOTIR-7462 / 7482 / 7810 (published results), `planning-workspace--pick-seed.mock.html` revision 3, `plan-change-run-live.mock.html` state A, the shipped `AiPaywall`.

---

## ⭐ The plan offer on an answer turn — Confirm and Decline, the mid-planning variant, and what Motir AI says instead when an offer cannot start (2026-10-22)

**Revised on review (2026-10-22, Mo — changes requested).** Two changes from the first draft: (1) a target that is **being planned right now** gets **no offer panel** — Motir AI tells the person directly, as one more line of its answer turn, that the target is being planned (sheet 4); `target_held` is no longer a cannot-start line. (2) **There is no planning session to open**: after Confirm the planning happens in this same overlay, below the turn, so the confirmed block drops _Open the planning session_ and says planning runs here (sheet 6).

**Revised on second review (2026-10-22, Mo — changes requested).** An offer that cannot start draws **no offer panel and no Decline** — there is nothing to confirm and nothing to decline (sheet 3). **A target that is done or cancelled gets no offer at all**: it stays the conversation phase. Motir AI reads the work item, says how the feature works now or why it was closed or cancelled (from what the card records), and asks what the person wants — rework it, or build something new on top. That is the answer itself, written by the answering session, not a stored line, so `target_closed` is no longer a cannot-start code. The remaining reasons (`planning_unavailable`, `out_of_credits`, generic) are one more Motir AI line in the answer turn, like the being-planned line. A press that is refused after the offer was shown (sheet 7) keeps the request and target, and replaces both buttons with the reason line.

**Design system — read first.** Files read: `package.json` (depends on `@motir/design-system` `workspace:*`, version `0.17.0` in `packages/design-system/package.json`) and `app/globals.css` (imports `@motir/design-system/theme.css`). **Verdict: ON MOTIR DESIGN.** The axes are the project's own (`app/layout.tsx` sets `data-style` / `data-palette` / `data-type` from the applied appearance), drawn here at the defaults the lifted sheet carries. The package does export `@motir/design-system/mock`, but this asset is drawn the way its area draws a delta — the stylesheet lifted verbatim from `planning-workspace--pick-seed.mock.html` with one appended token-only block — because the panel it composes, the guide's re-plan offer, is drawn that way, and a reviewer must be able to diff the two mocks line for line. Every part used is the package's (`Button`) or the project's own (`MarkdownView`, `WorkItemRefChip`); nothing is missing from either, so nothing is proposed as an addition.

**A DELTA.** The mock is **`design/ai-chat/plan-offer.mock.html`**. It holds only the plan offer's panel and its states on an answer turn in the planning overlay's conversation rail, and edits no existing mock. It composes the guide's re-plan offer (§ _The guide's re-plan offer_ above, `design/ai-chat/guide-replan-offer.mock.html`, shipped as `components/planning/GuideReplanOffer.tsx`) and the rail's answer turn (`components/planning/PlanChangeRail.tsx`). It does not redraw the in-run forward offer (`ForwardOffer` in `components/planning/MidRunTurn.tsx`), the new-session confirm, or the Plan something new control (§ _Plan something new_ above): a thread holding both draws two different panels, and the plan offer never renders inside a running turn.

**The access path** is the conversation itself, drawn in sheet 1: the person asks in the rail's composer, the answer ends with the panel, and the same composer takes a typed _yes_. No new door is drawn — the planning overlay is reached the shipped ways.

### What changes, in one sentence

An answer turn may now carry ONE stored plan offer. When it does, a panel under the answer restates the request the answering model wrote, names the target it would plan (or says there is none), and carries **Confirm** and **Decline**; when it does not, the turn renders exactly as an answer did before.

### Where it sits

Inside the answer turn: directly under the answer bubble, aligned with the bubble's left edge (the 36 px the avatar takes), and above the turn's passive meta line. A sibling of the mid-run panels the rail already draws, never inside one. It takes its width from the turn, adds no shadow (the rail's turn chrome owns elevation) and no animation.

### States, and the stored value each is drawn from

The panel derives everything from the stored offer on the turn, as served by the offer DTO: its derived **`state`** (`undecided` / `superseded` / `declined` / `confirmed`) and, while undecided, its **`cannotStart`** code. The DTO derives `state` from the stored fields — a confirmed session id ⇒ `confirmed`; a declined timestamp ⇒ `declined`; a later assistant turn in the thread carrying an offer ⇒ `superseded` (position, never written); otherwise `undecided` — so a reload shows the state the person left, never a client-side guess. The four values are the whole enum; the variants below are variants of `undecided`, not new stored values. The one exception is **being planned**, which is not a panel state at all: when the offer's target is being planned right now, the turn draws no panel and carries the being-planned line instead.

| Mock sheet · panel               | Stored value                                                                                 | What is drawn                                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 · absent                       | no offer on the turn (null)                                                                  | The answer and its meta line; no panel, no wrapper, no gap. A targeted _plan this_ that starts at once is this state: there was never an offer.                                                                                                              |
| 1 · undecided · can start        | `undecided`, `cannotStart` null, a target                                                    | label · request block · target row with chip · Confirm · Decline · helper line                                                                                                                                                                               |
| 1 · … target elsewhere           | as above, target ≠ the card the overlay was opened on                                        | adds the `targetElsewhere` line under the chip (only when the two differ)                                                                                                                                                                                    |
| 2 · undecided · no target        | `undecided`, no target                                                                       | the no-target line in place of the target row; Confirm stays; helper uses `confirmHelpNoTarget`                                                                                                                                                              |
| 3 · target done or cancelled     | no offer stored — the answering session made none, and core lands none for a closed target   | **no panel**: the answer explains the card's state from what it read and asks what the person wants next                                                                                                                                                     |
| 3 · cannot start (× 2 + generic) | an offer that cannot start (`planning_unavailable`, `out_of_credits`, any other value)       | **no panel, no Decline**: one more Motir AI line in the answer turn stating the reason (`plan-offer-cannot-start` + `data-reason`)                                                                                                                           |
| 4 · mid-planning                 | `undecided`, and the conversation holds a plan or a running run                              | `labelMidPlanning` heading and the mid-planning line above the actions                                                                                                                                                                                       |
| 4 · being planned                | an offer whose target is being planned right now (`target_held`), here or in another session | **no panel**: one more Motir AI line in the answer turn (`beingPlanned`, or `beingPlannedHere` when this conversation is the one planning it); no label, no Confirm, no Decline, nothing stored to press                                                     |
| 5 · confirming                   | `undecided` (in flight on the client)                                                        | Confirm's loading label; Confirm and Decline both disabled                                                                                                                                                                                                   |
| 5 · declining                    | `undecided` (in flight on the client)                                                        | Decline's loading label; both disabled; nothing switches until the decline is stored                                                                                                                                                                         |
| 5 · busy turn                    | `undecided`, a turn running under it                                                         | both disabled; nothing changes                                                                                                                                                                                                                               |
| 6 · confirmed                    | `confirmed`                                                                                  | request and target stay; the confirmed block (mint pill, confirmed-at, the `startedHere` line) replaces the actions; soft surface. No button: the planning runs in this overlay, below the turn                                                              |
| 6 · declined                     | `declined`                                                                                   | the declined block (chip, declined-at, recorded line) replaces the actions; soft surface                                                                                                                                                                     |
| 6 · superseded                   | `superseded`                                                                                 | the whole panel collapses to the one-line superseded paragraph                                                                                                                                                                                               |
| 7 · long request                 | any, request over 480 characters                                                             | the request block clamps to its maximum height with the show-all toggle; Show less when expanded                                                                                                                                                             |
| 7 · press refused                | `undecided`; the start refused at the press                                                  | the request and target stay; **Confirm and Decline both go**, replaced by the reason line — out of credits ⇒ `cannotStart.outOfCredits`; target no longer readable (`target_not_available`) ⇒ `cannotStart.targetUnavailable`; any other refusal ⇒ `generic` |
| 7 · narrow rail                  | any, at the rail floor (352 px)                                                              | the target row and the actions wrap; the request keeps its clamp; nothing scrolls sideways                                                                                                                                                                   |
| 8 · dark                         | any                                                                                          | the same panels on `data-theme='dark'`                                                                                                                                                                                                                       |

**A done or cancelled target is a conversation, never an offer.** The stored offer keeps only the target it was offered on, and a closed target cannot be planned, so there is nothing to confirm. The answering session is told not to offer one: it reads the card (status, the shipped pull requests, the closing or cancelling comment) and asks the person whether to rework it or build something new on top. Core backs that up: an offer on a closed target is not landed, and the answer stands alone.

**The cannot-start codes the rail draws** are the ones the offer DTO serves as `cannotStart`: `planning_unavailable` (no `ai:plan` or `work_item:edit`, or Motir AI not configured — the code does not tell those apart, so one line covers both) and `out_of_credits`. Each draws **one Motir AI line in the answer turn and no panel**. `target_closed` and `target_held` are not cannot-start lines: a closed target is a conversation (above), and a target being planned right now draws the being-planned line (no name, no avatar). Any other value draws `cannotStart.generic`, never a plausible real reason. The press-time refusal `target_not_available` draws `cannotStart.targetUnavailable` inside the shown panel, in place of its buttons.

### Elements, with their tokens

Each element is named once, so a consumer claims it by that name.

| #   | Element            | Primitive / markup                                                                                                                                                                    | Colour                                                                      | Shape / spacing                                                                                              | Test hook                                      |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 1   | panel              | `<section aria-label={label}>`                                                                                                                                                        | `--el-surface` undecided, `--el-surface-soft` decided; border `--el-border` | `--radius-card`, `--spacing-card-padding`, gap 2.5                                                           | `plan-offer` + `data-offer-state`              |
| 2   | label              | `<p>`, first child                                                                                                                                                                    | `--el-text-secondary`                                                       | text-xs semibold                                                                                             | —                                              |
| 3   | request block      | `MarkdownView` (item links render as `WorkItemRefChip`)                                                                                                                               | `--el-surface-soft`, border `--el-border-soft`, ink `--el-text`             | `--radius-input`, `--spacing-input-x` × `--spacing-control-y-8`, text-sm; clamped `max-h-32` above 480 chars | `plan-offer-request`                           |
| 3a  | show-all toggle    | `<button aria-expanded>`                                                                                                                                                              | `--el-link`, pressed `--el-link-pressed`; focus `--focus-ring-color`        | `--radius-control`, `--spacing-control-x-4`, text-xs medium                                                  | `plan-offer-show-all`                          |
| 4   | target row         | `<p>` label + chip                                                                                                                                                                    | `--el-text-secondary`                                                       | text-xs, gap 1.5                                                                                             | `plan-offer-target`                            |
| 4a  | target chip        | `WorkItemRefChip` when readable; mono badge fallback                                                                                                                                  | fallback `--el-chip-bg`, border `--el-chip-border`, ink `--el-text`         | `--radius-badge`, `--spacing-chip-x` / `--spacing-chip-y`, mono text-xs                                      | `plan-offer-target-chip`                       |
| 4b  | no-target line     | `<p>` with a left rule                                                                                                                                                                | ink `--el-text`, rule `--el-border-strong`                                  | border-l-2, pl-2, text-xs                                                                                    | `plan-offer-no-target`                         |
| 5   | mid-planning line  | `<p>`                                                                                                                                                                                 | `--el-text-secondary`                                                       | text-xs                                                                                                      | `plan-offer-mid-planning`                      |
| 6   | cannot-start line  | before a press: an extra Motir AI bubble in the answer turn, in place of a panel; after a refused press: `<p>` with a left rule and lock glyph `aria-hidden`, in place of the actions | bubble `--el-chat-bubble-ai`, ink `--el-text`; rule `--el-border-strong`    | bubble: `--radius-card`, px-3 py-2, text-sm; rule: border-l-2, pl-2, glyph size-3.5, text-xs                 | `plan-offer-cannot-start` + `data-reason`      |
| 7   | actions row        | wrapping row: `Button` primary `sm` (Confirm) · `Button` secondary `sm` (Decline)                                                                                                     | the shipped variants                                                        | gap 2; `--radius-btn`, `--height-btn-sm`                                                                     | `plan-offer-confirm` · `plan-offer-decline`    |
| 8   | helper line        | `<p>`                                                                                                                                                                                 | `--el-text-secondary`                                                       | text-xs, leading-relaxed                                                                                     | —                                              |
| 9   | confirmed block    | mint pill with check glyph `aria-hidden` · confirmed-at · runs-here line                                                                                                              | pill `--el-tint-mint`, ink `--el-text-strong`; lines `--el-text-secondary`  | `--radius-badge`, `--spacing-chip-x` / `--spacing-chip-y`, glyph size-3.5                                    | `plan-offer-confirmed`                         |
| 10  | declined block     | chip · declined-at · recorded line                                                                                                                                                    | chip `--el-chip-bg`, ink `--el-text-strong`; lines `--el-text-secondary`    | `--radius-badge`, `--spacing-chip-x` / `--spacing-chip-y`                                                    | `plan-offer-declined`                          |
| 10a | being-planned line | an extra Motir AI bubble in the answer turn (`--el-chat-bubble-ai`), aligned under the answer bubble, in place of a panel                                                             | ink `--el-text`                                                             | `--radius-card`, px-3 py-2, text-sm (the answer bubble's own box)                                            | `plan-offer-being-planned`                     |
| 11  | superseded line    | `<p>` replacing the panel                                                                                                                                                             | `--el-surface-soft`, ink `--el-text-secondary`                              | `--radius-card`, `--spacing-card-padding-12` × `--spacing-card-padding-8`, text-xs                           | `plan-offer` + `data-offer-state="superseded"` |

Timestamps use the rail's formatter convention (`dateStyle: 'medium', timeStyle: 'short'`), never a hand-built string. No raw hue, no `--color-*`, no `--el-danger-text`, and no `--el-text-muted` or `--el-text-faint` ink anywhere in the panel.

### Composition — measured off `components/planning/GuideReplanOffer.tsx` on the default branch

| Part            | The value the guide offer renders, reused unchanged                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| panel frame     | `flex flex-col gap-2.5 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding)`; `bg-(--el-surface)` → `bg-(--el-surface-soft)` once decided                         |
| label           | `text-xs font-semibold text-(--el-text-secondary)`                                                                                                                                          |
| request block   | `rounded-(--radius-input) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-input-x) py-(--spacing-control-y-8) text-sm`; `CLAMP_AT = 480` → `max-h-32 overflow-hidden` |
| show-all toggle | `rounded-(--radius-control) px-(--spacing-control-x-4) text-xs font-medium text-(--el-link)`, `aria-expanded`                                                                               |
| chip fallback   | `rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs`                                                 |
| rule lines      | `border-l-2 border-(--el-border-strong) pl-2 text-xs text-(--el-text)`; lock `size-3.5` `aria-hidden`                                                                                       |
| actions row     | `flex flex-wrap gap-2`; `Button` `primary` / `secondary`, `size="sm"`, `loading` while in flight                                                                                            |
| helper line     | `text-xs leading-relaxed text-(--el-text-secondary)`                                                                                                                                        |
| confirmed pill  | `rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)`, `CircleCheck size-3.5`                            |
| declined chip   | `rounded-(--radius-badge) bg-(--el-chip-bg) … text-xs font-semibold text-(--el-text-strong)`                                                                                                |
| superseded      | `rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-xs text-(--el-text-secondary)`                                            |

The plan offer is its OWN component — its stored object and its eligibility are not the guide's — so it carries its own test hooks (`plan-offer*`, above) rather than the guide's `guide-offer*`; it mirrors the tokens so two offers in one thread read as one family. Each `.po-*` rule in the mock's appended block cites the class string it mirrors.

### Copy — `planningWorkspace.planOffer`

Beside the guide offer's namespace. The mock renders the English below so the panel is reviewable; the key names, the ICU params and the meaning are fixed here, and the zh wording is authored with the catalogue strings. The request text is **data the answering model wrote**, never catalogue copy and never put in a URL.

| Key                               | Params   | Must say                                                                                       | en, as drawn                                                                                                                           |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `label`                           | —        | this is an offer to plan (heading and accessible name)                                         | Offer to plan                                                                                                                          |
| `labelMidPlanning`                | —        | the same, while the conversation is already planning something                                 | Offer to plan something else                                                                                                           |
| `target`                          | —        | the noun introducing the chip                                                                  | Target                                                                                                                                 |
| `noTarget`                        | —        | no card is targeted; what is planned is the request above                                      | No work item is targeted. What gets planned is the request above.                                                                      |
| `targetElsewhere`                 | `{key}`  | the target is not the card this overlay was opened on                                          | {key} is not the work item this conversation was opened on.                                                                            |
| `confirm` / `confirming`          | —        | Confirm, and its in-flight label                                                               | Confirm / Starting…                                                                                                                    |
| `decline` / `declining`           | —        | Decline, and its in-flight label                                                               | Decline / Declining…                                                                                                                   |
| `confirmHelp`                     | `{key}`  | what Confirm does, naming the target, and that replying yes does the same                      | Confirm starts planning {key} with this request, here in this conversation. Replying “yes” does the same.                              |
| `confirmHelpNoTarget`             | —        | the same with no target: Confirm plans the request on its own                                  | Confirm starts planning this request on its own, here in this conversation. Replying “yes” does the same.                              |
| `declineHelp`                     | —        | declining plans nothing and the conversation carries on                                        | Decline plans nothing, and the conversation carries on.                                                                                |
| `midPlanning`                     | —        | already planning something; confirming ends that plan and starts this one                      | This conversation is already planning something. Confirming ends that plan and starts this one, the way Plan something new does.       |
| `started`                         | —        | the confirmed pill: planning started                                                           | Planning started                                                                                                                       |
| `startedBy`                       | `{when}` | the confirmed-at line                                                                          | Confirmed · {when}                                                                                                                     |
| `startedHere`                     | —        | the planning runs in this conversation — there is no session to open                           | Planning runs here, in this conversation.                                                                                              |
| `beingPlanned`                    | `{key}`  | the target is being planned right now, so no offer is made (never a name)                      | {key} is being planned right now, so I haven’t offered to plan it again. You can follow that planning, or ask me about something else. |
| `beingPlannedHere`                | `{key}`  | the same, when this conversation is the one planning it                                        | {key} is already being planned here, in this conversation — the plan below is it.                                                      |
| `declined`                        | —        | the declined chip                                                                              | Declined                                                                                                                               |
| `declinedBy`                      | `{when}` | the declined-at line                                                                           | Declined · {when}                                                                                                                      |
| `recorded`                        | —        | nothing was planned                                                                            | Nothing was planned.                                                                                                                   |
| `replaced`                        | —        | a newer offer replaced this one                                                                | Replaced by a newer offer                                                                                                              |
| `showAll` / `showLess`            | —        | the clamp toggle                                                                               | Show all / Show less                                                                                                                   |
| `cannotStart.planningUnavailable` | —        | `planning_unavailable`: Motir AI not set up here, or no permission to plan and edit work items | Planning can’t start here: Motir AI isn’t set up for this project, or you don’t have permission to plan and edit work items.           |
| `cannotStart.outOfCredits`        | —        | `out_of_credits`: the organization is out of AI credits                                        | Your organization is out of AI credits, so planning can’t start.                                                                       |
| `cannotStart.targetUnavailable`   | `{key}`  | the start's access re-check refused: this person can no longer read the target                 | You can no longer open {key}, so planning can’t start.                                                                                 |
| `cannotStart.generic`             | —        | the fallback for any other reason or refusal, so the lookup is total                           | Planning can’t start from this offer.                                                                                                  |

The board's other strings are shipped rail copy it composes, not new keys: `conversation.answeredFrom` (the meta line) and `conversation.composerPlaceholder` (the composer).

### Accessibility contract

- The panel is a named region (`<section aria-label>`), announced as a section rather than loose text.
- Confirm and Decline are real buttons with visible labels — never icon-only.
- Confirmed and declined are conveyed in TEXT plus an icon, never by colour alone.
- The cannot-start line is a sentence carrying the reason in words, with no button beside it; the refused-press variant's lock glyph is `aria-hidden`, so the refusal survives without the icon, without colour, and in a screen reader.
- Each action carries its in-flight state (`aria-busy`, loading label), and both are disabled while one is in flight, so the exactly-once start is visible as well as enforced.
- The show-all toggle exposes `aria-expanded` and takes `--focus-ring-color`.
- No dialog sits between Confirm and the start — Confirm is the go. No live region is added on the request text; the rail's own turn insertion announces the run. No motion is introduced, so there is nothing to reduce.
- Focus order: show-all toggle → Confirm → Decline → the composer.

---

## The planning rail when the code cannot be searched

**Mock:** `plan-change-run-live--code-unsearchable.mock.html`. It is a delta beside
`plan-change-run-live--answer-or-forward.mock.html` (states 6–9, the run pause) and amends it
only by adding one more thing the rail can say; the older mock is a record and is not edited.
Surface: the conversation rail of the planning overlay (`PlanChangeRail`), as a member sees it.

**What it is for.** A planning phase that cannot search a target repository's code stops
instead of guessing. This is how the person is told, which repository and why, where to go to
fix it, and how to carry on.

### The banner (`data-testid="code-unsearchable-banner"`)

A region (`role="region"`, labelled by its title) placed in the rail's turn flow, after the
last turn, never above the header. Surface `--el-warning-surface`, ink `--el-warning-text`,
border `--el-border`, radius `--radius-card`, padding 12px (a layout gap, not a control's box).
Not rose and not `--el-danger-*`: the person did nothing wrong and nothing failed outright.

- **Title** (14px, semibold) with a pause glyph (`aria-hidden`): _Planning is on hold: Motir
  can't search your code yet._
- **Intro** (13px). Two wordings: stopped in the conversation (nothing was planned; send a
  message to try again) and stopped mid-walk (Motir stopped here).
- **Rows**, one per blocked TARGET repository (a `ul` labelled _Repositories that can't be
  searched_). A project's other repositories never appear. Each row: the repository name in
  `--font-mono` / `--el-text-strong`, a state chip at the end, and one line of explanation
  below in `--el-text-secondary`. Row surface `--el-card`, border `--el-border`, radius
  `--radius-control`, padding `--spacing-control-y` / `--spacing-control-x`. The chip is a
  `--el-tint-peach` badge with `--el-text-strong` ink, `--radius-badge`, `--spacing-chip-x/y`.
  The state is always worded for the reader, never the wire value:

  | wire state           | chip                    | line                                                                 |
  | -------------------- | ----------------------- | -------------------------------------------------------------------- |
  | never_indexed        | Never indexed           | Nothing has been indexed for it yet.                                 |
  | indexing             | Indexing in progress    | The first index is still running, so there is no code to search yet. |
  | refresh_failing      | Indexing keeps failing  | The last attempts to index it failed.                                |
  | paused               | Indexing is paused      | Indexing is paused for this project.                                 |
  | provider_unsupported | Host not supported      | Motir can't index repositories on this host.                         |
  | unavailable          | Code search unavailable | The code couldn't be read just now.                                  |

- **Go to Codebase** (`data-testid="code-unsearchable-codebase"`): a secondary-looking link
  button reading the shipped `goToCode` string, `href="/code"`. Always shown.
- **Check again and continue** (`data-testid="code-unsearchable-resume"`): a primary
  `Button` (`--el-accent` fill, `--el-accent-text` ink, `--height-btn-sm`). It answers the
  run's pause with the new `resume` choice. It is NOT one of the run pause's _Start over_ /
  _Keep going_ pair and never appears beside them: a code stop is its own pause kind with its
  own single control. **Shown only while a run is paused**; a conversation that stopped before
  any job opened has no resume button, because the person's next message is the retry.
- Order: resume first, then the link. Both wrap at narrow width.

### States

1. **Stopped in the conversation.** The banner follows the person's last message. The composer
   stays enabled. No resume button.
2. **Stopped mid-walk.** The proposals made so far stay in the rail. A quiet centred record line
   (`--el-text-secondary`, 12px) says they are kept and nothing more is added. The banner
   follows with the resume button.
3. **Several rows.** All six states can be listed; order is by repository name.
4. **Resume.** Pressing _Check again and continue_ disables the button while the answer is
   sent. If the run goes on, the banner is replaced by the run's existing resumed marker. If the
   re-check finds a repository still blocked, the banner STAYS, its rows update to the current
   states, and a status line (`role="status"`, `--el-warning-text`) says _Checked just now:
   {repo} still can't be searched. It now shows {state}._ The person's _Check again and
   continue_ turn stays above it.
5. **Narrow width.** Rows keep the name and chip on one line until they cannot; the hint wraps
   under; the actions wrap onto two lines. Nothing scrolls sideways.

### Accessibility

The title is the region's label. The row list has an accessible name. The status line is a
polite live region so a re-check result is announced. Both controls meet the shared focus ring
(`--focus-ring-color`). No state is carried by colour alone: every chip says the state in words.

### Copy (en / zh)

The mock ends with the copy table for every new string in both languages. The link reuses the
shipped `goToCode` string unchanged.

## ⭐ The Motir mark at work — the colour wave flow in the working turn's avatar (MOTIR-9212, 2026-10-21)

Yue picked the **colour wave flow** for the Motir mark on 2026-10-21 (the _"B in the plan overlay"_
direction of the logo-motion prototype). This section turns that prototype into a specification. The
mark moves whenever Motir AI is doing something in the plan overlay, and it moves in ONE place: the
round ink avatar of the turn Motir is working on, beside the planner notes. Implementation is
**MOTIR-9213**.

**Design system, identified first.** Read `package.json` (depends on `@motir/design-system`,
`workspace:*`) and `app/globals.css` (line 13, `@import '@motir/design-system/theme.css'`). Both hold,
so the verdict is **(a) ON MOTIR DESIGN**, package **v0.14.0** (`packages/design-system/package.json`).
The project's axes are per person (`app/layout.tsx`), so the board renders at the package defaults
(`warm-editorial` · `motir` · `motir`) and is built with the package's `renderMock`. Every part on this
surface is product-local, so the board composes those parts' **real emitted markup**:

| part                                                                          | kind                    | reason                                             |
| ----------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------- |
| `PlanChangeRail` (header, turn bubbles, hand-off, composer)                   | product-local component | the planning rail                                  |
| `PlanActRecord` · `PlanNarration` (the act record and the planner notes)      | product-local component | the two blocks the working turn now holds          |
| `BrandMark` (`@motir/brand`, re-exported by `components/brand/BrandMark.tsx`) | brand package part      | the mark this section moves; not the design system |

Three colour roles are proposed for `@motir/design-system`'s `theme.css` Tier 3 (below). Nothing else
is added to the package.

**Amends, on the record:** § _⭐ Motir at work — the drafted card turns warm orange, pops and breathes,
and one Motir mark in the rail breathes with it (MOTIR-8414)_, its sub-sections **The States table —
total, card and mark** (the mark column), **Where the mark sits** and **Token roles** (the _the mark_
row), and its mock [`planning-workspace--at-work.mock.html`](./planning-workspace--at-work.mock.html)
(the rail header in panels 1 and 9). The drafted card's cue in that section is NOT changed. Neither
mock is edited.

**Asset:** [`planning-workspace--mark-at-work.mock.html`](./planning-workspace--mark-at-work.mock.html),
a **delta** holding only the panels that change. Its live marks run the specified motion in a browser
and stop under `prefers-reduced-motion: reduce`.

| Panel | What it shows                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| 1     | A plan run writing: the header without its mark, and the working turn as ONE row with the flowing avatar   |
| 2     | A conversation turn being read: the act record gains the row and its flowing avatar                        |
| 3     | The reply landed: every avatar still, the row gone                                                         |
| 4     | Stalled, reconnecting, resuming, settled: the row stays and its avatar holds the still white mark          |
| 5     | The motion, frame by frame, at the specified energy, the rest frame first, and one live zoomed mark        |
| 6     | The three colour roles on the ink circle, and the avatar and orb sizes, shipped and new                    |
| 7     | Panel 1 under `prefers-reduced-motion: reduce`                                                             |
| 8–10  | Panels 1, 5–6 and 7 in dark (a nested `data-theme="dark" data-appearance-scope` frame, so the tokens flip) |

### Rendered before drawn

Every rail is the emitted markup of `PlanChangeRail` at motir-core `6502714`, captured with
`tests/helpers/renderWithIntl` → `container.innerHTML` (en), one capture per state: a plan run in its
planning phase (`phase: 'streaming'`, the job settled, the hand-off bubble, two acts, two planner-note
groups), a conversation turn being read (`phase: 'streaming'`, `reading` act), and a finished reply.
What the render showed:

- **The planner notes and the act record carry NO avatar.** `PlanActRecord` and `PlanNarration` render
  as bare blocks in the transcript. The only avatar near them is the hand-off bubble's
  (`plan-handoff`), which sits ABOVE them and only while a plan run writes. While a conversation turn
  streams (reading the request, looking things up, matching a bug), there is no Motir avatar on screen
  for the work at all: the act record stands alone until the reply lands.
- **The header mark does not move while a conversation turn streams.** `PlanAtWorkMark` reads only the
  plan's progress (`state.liveReview?.progress`), so it says _"at work"_ for a plan being written and
  nothing for an ask, a debug turn or the conversation phase of a plan run. Both captures read
  `data-at-work="false"`.
- **Every Motir avatar glyph is 13 px in a 28 px disc** (`size-7`, `BrandMark size={13}`), from two
  places in the file: `Bubble` (the opener, every reply, the hand-off) and the stale notice. The disc
  does not clip (`overflow` is visible).

### What the mark answers, and the one datum

**The moving mark says _Motir AI is working on this turn now_.** It is not a progress bar and not a
state word; the act record and the progress line carry those. It is ONE boolean, `motirAtWork`,
derived in the rail from data it already holds, as the OR of two halves:

```ts
// A plan being written that the rail watches: a plan run in its planning phase, a
// reopened generating plan, or an agent writing it over MCP (which has no job at all).
const planAtWork = state.liveReview?.progress
  ? readPlanAtWork(reading, { failing: state.liveFailing }).atWork // the retired header mark's reading
  : false;
// Any other job of this session streaming to this viewer: an ask turn being read, a
// look-up, a debug turn matching or writing, a plan run still in its conversation phase.
const turnStreaming = state.phase === 'streaming' && planRunPhase(state) !== 'planning';
const motirAtWork = planAtWork || turnStreaming;
```

`reading` is `usePlanProgressReading(state.liveReview?.progress ?? null, { failing: state.liveFailing })`,
the one clock the header mark used (`lib/plans/planProgress.ts`, `lib/hooks/usePlanProgressReading.ts`);
nothing here compares a timestamp or names a state. **While a plan run is in its planning phase the
stream does not count**, so the plan reading alone decides, because it alone knows `stalled`,
`reconnecting` and `resuming`: a stream still open over a stalled plan does not keep the mark moving.
Everything else Motir AI does in the overlay reaches the rail as a streaming job, and moves the mark
for as long as it streams. Nothing running (`idle`, `review`, `deciding`, `loading`, an ended session,
a Visitor watching no job) is `false`.

**Per the shipped reading's states** (§ _Motir at work_ › _The States table_, the mark column, now on the
avatar): `starting`, `working` (one or several live steps, on or off the viewed level) and `writing`
**flow**; `stalled`, `reconnecting`, `resuming` and `settled` are **still**. A cue that leaves while the
plan still generates changes nothing on the mark, because the state decides.

### Where the mark sits — the working turn is ONE row

The turn Motir is working on becomes ONE row with ONE avatar, `data-testid="plan-work-row"`:

```tsx
<div className="flex items-start gap-2" data-testid="plan-work-row">
  {/* the shipped 28 px disc, now clipping */}
  <span
    aria-hidden="true"
    data-testid="plan-at-work-mark"
    data-at-work={motirAtWork}
    className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-(--el-accent) text-(--el-accent-text)"
  >
    {/* the flowing mark while motirAtWork, else BrandMark variant="mark" tone="inverted" size={17} */}
  </span>
  <div className="flex min-w-0 flex-1 flex-col gap-3">
    {/* the hand-off bubble (a plan run writing), then PlanActRecord, then PlanNarration */}
  </div>
</div>
```

- **A plan run writing** (panel 1): the hand-off bubble gives up its own avatar and becomes the row's
  first message; the act record and the planner notes follow it in the same column. One avatar, beside
  the planner notes.
- **A conversation turn streaming** (panel 2): the act record is the row's only content until the
  reply lands; then the row is gone and the reply is an ordinary `Bubble` with the still mark (panel 3).
- **The row is drawn whenever its content is** (the hand-off, the act record or the planner notes): a
  reopened finished plan shows its planner notes in this row, with the still mark (panel 4).
- **Only this avatar ever moves.** The opener, every finished reply, the stale notice and every other
  `Bubble` hold the still mark. There is at most one moving mark in the overlay.
- **The test hooks move with the motion.** `data-testid="plan-at-work-mark"` and `data-at-work` leave the
  header and go on this avatar, so the observable contract MOTIR-8419 walks keeps its names.
- Not moved and not changed: the act record's own spinner on its live row (MOTIR-4069) and the canvas's
  drafting cue (MOTIR-8414), which answer different questions.

### What happens to the breathing `PlanAtWorkMark` — RETIRED

The rail header returns to its shipped form before MOTIR-8417: status dot, _Motir AI_, mode chip
(panels 1–4). **Why retire rather than keep:** two marks moving at once (the header breath and the
avatar flow) is exactly what the direction rules out, and the avatar is the better home: it sits beside
the work, and it also covers the conversation turns the header never did. **Why not replace in
place:** the header is 14 px of chrome far from the notes, and the header slot carries no turn, so _"the
turn Motir is working on"_ has no meaning there. Concretely, for MOTIR-9213: the header mount goes, the
rule `.plan-at-work-mark[data-at-work='true'] > .brand-glyph` (the `--el-drafting` ink and the
`canvas-cue-breathe` animation) leaves `app/globals.css`, and `PlanAtWorkMark` either becomes the
avatar component or is deleted. `--el-drafting` stays: the canvas cue uses it.

### The motion — every parameter

The mark is the shipped `WAVE_BAND_PATH` (`packages/brand/src/waveBand.ts`, the single source of the
rest shape), re-written every animation frame. `t` is seconds since the mark started flowing, `e` the
energy, `u = x / 24` each point's position along the band, and each point `(x, y)` of the path moves to
`(x′, y′)`. The points before the path's `L` command are the TOP edge, the `L` point and after are the
BOTTOM edge.

| parameter                            | value                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| energy `e` while flowing             | **0.75** (the prototype's default)                                                                                                                                                                                                                                                         |
| travelling wave, both edges together | `dy₁ = 3.4·e · sin(2.4·t − 2π·u) · (0.35 + 0.65·sin(π·u))` → amplitude **2.55** units, **2.4 rad/s**, one wavelength across the band                                                                                                                                                       |
| left cap height `hL`                 | `max(0, 12 − 4·e + 16·e·sin(1.3·t))` → **0 to 18** units at `e = 0.75` (the band pinches to a point), **1.3 rad/s**                                                                                                                                                                        |
| right cap height `hR`                | `max(0, 12 − 4·e + 16·e·sin(1.05·t + 2.2))` → **0 to 18** units, **1.05 rad/s**                                                                                                                                                                                                            |
| the middle, blending the caps        | `th = 12 + (hL − 12)·(1 − u)² + (hR − 12)·u²`; each edge moves by `dy₂ = ±(th − 12) / 2` (top `−`, bottom `+`)                                                                                                                                                                             |
| width breathing, left side in        | `L = 2.6·e · (0.5 + 0.5·sin(1.3·t))` → **0 to 1.95** units                                                                                                                                                                                                                                 |
| width breathing, right side in       | `R = 2.6·e · (0.5 + 0.5·sin(0.9·t + 2))` → **0 to 1.95** units, **0.9 rad/s**                                                                                                                                                                                                              |
| the point                            | `x′ = x + L·(1 − u) − R·u`, `y′ = y + dy₁ + dy₂`                                                                                                                                                                                                                                           |
| colour: hue position                 | `c = 0.45·t` hue steps; the three roles in a loop 1 → 2 → 3 → 1 (one loop every **6.7 s**)                                                                                                                                                                                                 |
| colour: the two gradient stops       | stop 0 at `c`, stop 1 at `c + 1` (a third of the loop ahead); between roles `i` and `i + 1` the stop is `color-mix(in srgb, role(i+1) k%, role(i))` with `k` the smoothstep of the fraction                                                                                                |
| colour: the gradient axis            | `linearGradient`, `gradientUnits="userSpaceOnUse"`, from `(12 − 12·cos a, 12 − 12·sin a)` to `(12 + 12·cos a, 12 + 12·sin a)`, `a = 0.6·t` (one turn every **10.5 s**)                                                                                                                     |
| starting and stopping                | `e` eases **0 → 0.75** when `motirAtWork` turns true and **0.75 → 0** when it turns false, over `2 × --transition-slow` (500 ms), ease-out; each stop is mixed toward `--el-accent-text` by `1 − e / 0.75`. At `e = 0` the path is exactly `WAVE_BAND_PATH` and the fill is `currentColor` |
| frame source                         | `requestAnimationFrame`; paused while the tab is hidden or the avatar is off screen (an `IntersectionObserver`)                                                                                                                                                                            |
| frame rate and flashing              | every value is a smooth sinusoid at most 2.4 rad/s (0.38 Hz); nothing flashes (well under the WCAG 2.3.1 three-per-second bound)                                                                                                                                                           |

**One deliberate change to the prototype:** the cap heights are written `12 − 4·e + 16·e·sin(…)`
where the prototype wrote `9 + 12·e·sin(…)`. At the chosen energy the two are identical, but only the
new form is the rest shape at `e = 0`, which is what lets the mark ease in from rest and back to it
instead of jumping on its first and last frame.

**At rest the mark is the shipped glyph**, `BrandMark variant="mark" tone="inverted"`, in
`--el-accent-text`. Every animation ends on exactly that path and fill.

### The colour — three new roles

The prototype painted the hues of the OPPOSITE theme onto the circle, because the raw wave hues do not
read on the ink circle: on Motir light, `--el-showcase-wave-1` is 2.68:1 on `--el-accent`; on Motir
dark the three are 1.88 / 2.16 / 2.84:1. A theme flip cannot be expressed as a token, and across the
other palettes the opposite theme's hues measure as low as 1.00:1 (amber light, citrine dark), because
there the accent IS one of the wave hues. So each role is the palette's own hue pulled toward the ink
that already sits on the circle, the same shape as `--el-danger-on-surface`:

```css
/* theme.css Tier 3 — base (and every palette but Motir) */
--el-mark-wave-1: color-mix(in srgb, var(--el-showcase-wave-1) 35%, var(--el-accent-text));
--el-mark-wave-2: color-mix(in srgb, var(--el-showcase-wave-2) 35%, var(--el-accent-text));
--el-mark-wave-3: color-mix(in srgb, var(--el-showcase-wave-3) 35%, var(--el-accent-text));

/* [data-palette='motir'] and its dark block — the default palette keeps more of its hue */
--el-mark-wave-1: color-mix(in srgb, var(--el-showcase-wave-1) 60%, var(--el-accent-text));
--el-mark-wave-2: color-mix(in srgb, var(--el-showcase-wave-2) 60%, var(--el-accent-text));
--el-mark-wave-3: color-mix(in srgb, var(--el-showcase-wave-3) 60%, var(--el-accent-text));
```

Measured with the token layer's own resolver (`tests/theme/paletteCascade.ts`,
`tests/theme/colorMetrics.ts`) against `--el-accent`, the circle. The mark is a graphical object, so
the floor is WCAG 1.4.11's **3:1**. The last column is the lowest value anywhere the mark can paint:
each role, every srgb blend between two neighbouring roles (the gradient), and every point of the
start/stop ramp toward the ink.

| palette   | theme | circle    | roles 1 · 2 · 3               | each on the circle   | lowest anywhere |
| --------- | ----- | --------- | ----------------------------- | -------------------- | --------------- |
| motir     | light | `#1a1d21` | `#739ddc · #6ebcb6 · #e6a066` | 6.11 · 7.68 · 7.72   | 6.11            |
| motir     | dark  | `#edeef0` | `#506f9f · #20726b · #9b3806` | 4.40 · 4.91 · 6.11   | 4.40            |
| amethyst  | light | `#5645d4` | `#c4bef0 · #b4dddb · #ffc9ec` | 3.74 · 4.47 · 4.63   | 3.74            |
| amethyst  | dark  | `#6c5cdd` | `#d1ccf6 · #b4dddb · #ffc9ec` | 3.25 · 3.40 · 3.52   | 3.25            |
| cobalt    | light | `#3650c2` | `#bac4ee · #abd8d5 · #abd9e1` | 3.96 · 4.38 · 4.46   | 3.96            |
| cobalt    | dark  | `#4a63cf` | `#d2dbfa · #b6e5e1 · #b6eaf1` | 3.84 · 3.84 · 4.03   | 3.82            |
| evergreen | light | `#0c7a52` | `#aacdc0 · #aad6d5 · #d3c4f6` | 3.11 · 3.39 · 3.31   | **3.11**        |
| evergreen | dark  | `#3ddc97` | `#195a3d · #14574b · #3e3e60` | 4.62 · 4.76 · 5.76   | 4.62            |
| spectrum  | light | `#5a37c9` | `#c9bcf1 · #aadad5 · #f5bbdb` | 4.23 · 4.85 · 4.61   | 4.23            |
| spectrum  | dark  | `#6d4fd6` | `#e0d6fd · #b6eae6 · #ffc7e3` | 4.07 · 4.25 · 3.89   | 3.89            |
| amber     | light | `#f0b90b` | `#3b3315 · #154344 · #443a1e` | 6.97 · 6.07 · 6.23   | 6.07            |
| amber     | dark  | `#fcd535` | `#5f541e · #17534e · #5b4a0f` | 5.30 · 6.17 · 6.05   | 5.30            |
| sienna    | light | `#fa520f` | `#5b2006 · #203e32 · #5b2f07` | 3.80 · 3.49 · 3.39   | 3.39            |
| sienna    | dark  | `#ff7a38` | `#753c1e · #2b5646 · #754409` | 3.34 · 3.21 · 3.13   | 3.13            |
| garnet    | light | `#c30021` | `#eaa6b1 · #abd8d5 · #dcb6d2` | 3.17 · 4.04 · 3.49   | 3.17            |
| garnet    | dark  | `#c30021` | `#ffc5cf · #b6f0e9 · #f5c6e6` | 4.23 · 4.98 · 4.22   | 4.21            |
| citrine   | light | `#ffd02f` | `#2c222d · #101359 · #171f7e` | 10.42 · 11.37 · 9.33 | 9.33            |
| citrine   | dark  | `#ffd02f` | `#5d4935 · #2e327d · #23297d` | 5.80 · 7.66 · 8.50   | 5.80            |
| candy     | light | `#efbfdd` | `#82195d · #4d3a54 · #7e2671` | 5.86 · 6.43 · 5.48   | 5.48            |
| candy     | dark  | `#ff8dcc` | `#6f3d5a · #20574c · #664068` | 3.99 · 3.93 · 3.98   | 3.93            |

**Why 35% and 60%.** 35% is the largest single share of the hue for which all twenty pairs clear 3:1
(at 36% the lowest pair falls to 3.07, at 38% to 2.92; at 35% evergreen light, 3.11, is the binding pair). Motir, the
default palette and the one the direction was approved in, keeps far more of its colour: at 60% its
lowest is 4.40:1, and the hues stay the blue, teal and orange of the prototype. A guard in the shape of
`tests/theme/liveLinkInks.test.ts` should hold all twenty pairs, blends included, at 3:1 (MOTIR-9213).

**No raw colour.** The three roles are `color-mix` over `--el-*` only, so a palette swap re-tints the
mark and a theme flip re-measures it; the gradient stops at runtime are `color-mix` over the three
roles.

### Sizes

| where                                                         | shipped           | now                                                                                                                  |
| ------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| every Motir avatar in `PlanChangeRail` (28 px disc, `size-7`) | 13 px glyph (46%) | **17 px** glyph (60%), still or flowing; the disc gains `overflow-hidden`, so a swollen cap is clipped by the circle |
| the Plan with AI orb (`PlanWithAIFab`, 56 px)                 | 26 px glyph (46%) | **34 px** glyph (60%), **still** — it does not flow                                                                  |

The orb is drawn at its new size in panel 6 only as a size specimen; its fill, glow and pulse are the
ones `ai-callout-menu.mock.html` specifies and are unchanged. **The orb does not flow**, because it
sits outside the overlay's transcript and a second moving mark would break the one-moving-mark rule
whenever the overlay is open. Two notes for whoever builds the orb's size: `tests/theme/orb-glyph-contrast.test.ts`
reads the 26 px box from `ai-callout-menu.mock.html` and `PlanWithAIFab.tsx`, and its sample point (the
gradient's first, lightest stop) is asserted to be the worst case, so the larger glyph needs no new
contrast measurement, only the size in that guard moved with it. **MOTIR-9213's scope is the plan
overlay only, so the orb's size is NOT in it** (see GIVES / TAKES).

### Reduced motion

Under `prefers-reduced-motion: reduce` **no frame loop runs** and the avatar shows the still glyph,
`BrandMark variant="mark" tone="inverted" size={17}`, in `--el-accent-text`: no shape change, no colour
change, no fade (panels 7 and 10). The row, its placement and the `data-at-work` attribute are the
same, so _"Motir is working on this turn"_ is still told by the act record's words and spinner and by
the progress line, never by the mark alone. The motion is opt-in: the still glyph is the default, and
the flow starts only under `prefers-reduced-motion: no-preference`.

### Accessibility

- **The mark stays decorative.** The disc is `aria-hidden`, so is the glyph, and neither carries a
  label. No role, no name, no live region and no tab stop is added. The transcript's `role="log"` and
  the act record's one polite region are untouched.
- **Nothing reads the colour for meaning.** The roles carry no state; their 3:1 floor is so the mark
  stays visible as the mark.
- **A moving indicator of a running process**, like the act record's spinner: it starts with the work
  and stops with it, it honours reduced motion, and it never flashes.

### Copy — a decision: no string is added

The mark carries no text, and the row reuses the shipped strings of the bubbles, acts and notes it
gathers. No key is added in either language.

### GIVES / TAKES

- **MOTIR-9213** (the build) — **TAKES** all of it: the `motirAtWork` derivation and its table, the
  working-turn row and its markup, the moved test hooks, the 17 px avatar glyph and the clipping disc,
  the motion table (including the easing in and out), the three roles in `theme.css` (base and both
  Motir blocks) with a twenty-pair guard, the reduced-motion form, and the header mark's retirement.
  It does **NOT** take the orb's 34 px: its scope boundary is the plan overlay. The orb's size needs
  either a line added to MOTIR-9213 or its own card; this design names it so the decision is visible,
  and does not make it.
- **MOTIR-8417** (the header mark, done) — its mount and its breath are **taken away** by this section.
- **MOTIR-8418** (the at-work coverage and integration gate, done) — `tests/helpers/atWorkStorySurface.ts`
  names `plan-at-work-mark` / `data-at-work` as `HOOKS` and the header mount as reported; those hooks
  survive on the avatar, and the mount moves within `PlanChangeRail.tsx`. MOTIR-9213 updates the
  enumeration and its sweeps.
- **MOTIR-8419** (the E2E) — **GIVES** nothing new to walk; the hook names are kept so it keeps passing
  once its locator follows the avatar.
- **MOTIR-8414** (the drafting cue) — the card's colour, pop and breath are unchanged.
- **MOTIR-4069** (the act record) and **MOTIR-8060** (the planner notes) — **GIVE** the two blocks the
  row gathers; neither block's own markup changes.

### What this section does not draw

- The mark's other homes: sign-in and onboarding, the top bar, loading screens, the AI callout's own
  rows. The prototype's other three motions (draw-on, shimmer, hover ripple) are not specified here.
- The canvas pane, the progress line and every word in the rail.
- A new door: the overlay is opened exactly as `planning-workspace.mock.html` draws, from the Plan with
  AI orb or the header pill.

## ⭐ The overlay's History section — your own conversations in this project, under the rail head (MOTIR-9305, 2026-10-22)

**Mock:** `design/ai-chat/planning-workspace--history.mock.html` (a delta; panels 1–9).
**Amends** §_The conversation_ (the rail, `planning-workspace.mock.html`) by adding one collapsible
section between the rail head and the thread, and §_Plan something new_ (MOTIR-7647,
`planning-workspace--plan-something-new.mock.html`) only in that its rail head now sits above the
section. The rows reuse the Plans list's row vocabulary (`design/ai-planning/plans-tabbed-list.mock.html`,
MOTIR-3233; shipped as `app/(authed)/plans/_components/SessionRow.tsx`) at rail size, without
redrawing that page. No existing mock is edited.

**What was drawn from.** The mock mirrors the shipped markup of `components/planning/PlanChangeRail.tsx`
(the aside, the head, the `role="log"` thread and the composer slot), `components/planning/SessionEndParts.tsx`
(the end marker and the ended composer slot), `components/ui/Pill.tsx` and the Plans row. It was
composed from those components' classes and the theme's tokens; the live app was not rendered for
this card.

**The ask (MOTIR-9218).** A member sees, inside the planning overlay, the conversations THEY started in
this project (`created_by_id` = viewer, `origin <> 'guide'`), open or ended, newest activity first,
ten at a time, and can open any of them in place. The read is `GET /api/ai/plan-change/sessions/history`
(MOTIR-9306).

### Panel 1 — the entry path (collapsed)

- A `<section class="hx" aria-label="History">` placed directly under the rail head and above the
  `role="log"` thread, in every rail mode. It is chrome like the head: it does not scroll with the
  thread.
- The header is one `<button aria-expanded="false" aria-controls="hx-region">` row: `ChevronRight`
  (14px, rotates 90° when open), `History` glyph (14px), label `planningWorkspace.history.header`.
  Height `--height-control`, padding `0 --spacing-control-x-16`, 13px/500 `--el-text`; the section's
  bottom hairline is `--el-border-soft` (the head's own hairline token).
- Hover `--el-muted` fill; focus the shipped `--focus-ring-color` ring (drawn on panel 1 as the
  focused state).
- **Collapsed on every overlay open.** Nothing is fetched while it is collapsed.
- `data-testid="planning-history-toggle"`.

### Panel 2 — expanded: the first page

- Expanding re-reads page 1 (no stale cache between expands) and shows the loading state: three
  skeleton rows (`.hx-skel`, `--el-muted` bars, `--radius-control`) under a polite
  `role="status"` reading `planningWorkspace.history.loading` (visually hidden beside the bars).
  `prefers-reduced-motion: reduce` drops the shimmer.
- The list is `<ul id="hx-region" aria-label="{planningWorkspace.history.regionAria}">`, max-height
  300px, scrolling on its own; the thread below keeps the remaining height.
- Ten rows per page. Drawn: row 1 the currently open session (marker below), row 2 hovered
  (`--el-muted`), row 3 focused (ring).
- `data-testid="planning-history-list"`, each row `planning-history-row`.

### Panel 3 — the row, named once

| element            | what it shows                                                                                                                                                          | tokens                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| row                | an `<a>` (one tab stop) to the session; padding `--spacing-control-y-8` / `--spacing-control-x-8`, `--radius-control`                                                  | hover `--el-muted`; focus `--focus-ring-color`                           |
| first-turn line    | the session's first user turn, one line, ellipsis; else the latest plan's title; else `aiPlanning.sessions.untitled`. Full text in `title`.                            | 13px/500 `--el-text`; ended rows `--el-text-secondary`                   |
| anchor chip        | the first anchor key in mono, `aiPlanning.sessions.anchorMore` for more, full set in `title`; a project-wide session reads `aiPlanning.sessions.anchorProject` as text | neutral chip (`--el-chip-bg`, `--el-chip-border`, `--el-text-secondary`) |
| last-active time   | `aiPlanning.sessions.lastActive`, relative                                                                                                                             | 12px `--el-text-secondary`                                               |
| status pill        | `planningWorkspace.history.status.open` or `.ended`                                                                                                                    | `Pill` mint (`--el-tint-mint`, `--el-text-strong`) · archived tone       |
| plan state pill    | only when `planCount > 0` and the state is not `none` / `closed`: `aiPlanning.sessions.planState.*` with the Plans page's tone (Writing sky, Waiting lavender, …)      | `Pill` tinted tones, `--el-text-strong` ink                              |
| ended treatment    | secondary ink on the first-turn line plus the Ended pill. No opacity.                                                                                                  | `--el-text-secondary`                                                    |
| currently open row | the session the rail shows now: page-white fill with a 2px leading accent bar, `aria-current="true"`                                                                   | `--el-page-bg`, `--el-accent`                                            |

The row's accessible name is `planningWorkspace.history.rowAria`. A long first turn truncates on one
line at every width (drawn on panel 3 and at the floor on panel 8).

### Panel 4 — paging states

- **Loading more.** An `IntersectionObserver` sentinel after the last row fetches the next page; the
  last row receiving keyboard focus fetches it too. While it loads, a `role="status"` footer row:
  spinner (`--el-text-secondary`) + `planningWorkspace.history.loadingMore`.
- **End of list.** `nextCursor` null: hairline–text–hairline (`--el-border-soft`, 12px
  `--el-text-secondary`) reading `planningWorkspace.history.end`.
- **Error, first page.** In place of the list: `CircleAlert` glyph (`--el-danger-on-surface`) +
  `planningWorkspace.history.error` in `--el-text`, and a link-styled **Retry** button
  (`aiPlanning.sessions.loadMoreRetry`, `--el-link`). `role="alert"`.
- **Error, next page.** The rows stay; the footer row reads `aiPlanning.sessions.loadMoreError` with
  the same Retry.

### Panel 5 — empty, and who sees the section

- **Empty.** `MessagesSquare` glyph (`--el-text-secondary`, `aria-hidden`), title
  `planningWorkspace.history.emptyTitle` (13px/600 `--el-text`), body
  `planningWorkspace.history.emptyBody` (12px `--el-text-secondary`).
- **Visitors get no section** — not collapsed, not disabled: absent. Members see it in every mode,
  including a read-only reopen.

### Panel 6 — opening a row

- The row opens the session INSIDE the overlay through the shipped `planSession` reopen, with the
  same launch context the Plans row builds (`launchContextFor`: the first anchor key, or the project,
  carrying the session id). The overlay, the canvas frame and the rail width stay put; the section
  stays expanded and keeps its scroll, and the opened row becomes the current row.
- **An open row** opens the live conversation with its composer.
- **An ended row** opens read-only: the thread ends with the shipped `SessionEndMarker` and the
  composer slot is the shipped `EndedComposerSlot` — its gloss and **Start a new session**, which
  carries the conversation into a new session. Nothing new is drawn for it.

### Panels 7–9 — dark parity, the 352px floor and zh

Every element is drawn under `data-theme="dark"`; all inks are `--el-text`, `--el-text-secondary`,
`--el-text-strong` on tints, `--el-link` and `--el-danger-on-surface`, which clear AA on both themes.
At the rail's 352px floor the first-turn line truncates first, then the anchor chip (max 11rem); the
pills never wrap. The zh panel shows the header, the pills and a row in Chinese.

### Keyboard and assistive tech

- Tab reaches the header button, then each row (one stop each), then the thread. Enter / Space on the
  header toggles; Enter on a row opens it.
- `aria-expanded` and `aria-controls` on the header; the list is labelled by `regionAria`;
  the current row carries `aria-current="true"`; loading and loading-more are polite `role="status"`;
  errors are `role="alert"`.
- Focus is never moved by loading a page.

### Copy index

| key                                      | en                                                                     | zh                                             |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `planningWorkspace.history.header`       | History                                                                | 历史记录                                       |
| `planningWorkspace.history.regionAria`   | Your past conversations in this project                                | 你在此项目中的过往对话                         |
| `planningWorkspace.history.status.open`  | Open                                                                   | 进行中                                         |
| `planningWorkspace.history.status.ended` | Ended                                                                  | 已结束                                         |
| `planningWorkspace.history.loading`      | Loading your conversations…                                            | 正在加载你的对话…                              |
| `planningWorkspace.history.loadingMore`  | Loading more…                                                          | 正在加载更多…                                  |
| `planningWorkspace.history.end`          | No older conversations                                                 | 没有更早的对话                                 |
| `planningWorkspace.history.emptyTitle`   | No conversations yet                                                   | 还没有对话                                     |
| `planningWorkspace.history.emptyBody`    | Questions you ask and plans you start in this project are listed here. | 你在此项目中提出的问题和开始的规划会列在这里。 |
| `planningWorkspace.history.error`        | Couldn’t load your conversations.                                      | 无法加载你的对话。                             |
| `planningWorkspace.history.rowAria`      | {title} · {status} · active {when}                                     | {title} · {status} · {when}活跃                |

Reused, unchanged: `aiPlanning.sessions.untitled`, `.lastActive`, `.anchorProject`, `.anchorMore`,
`.planState.*`, `.loadMoreError`, `.loadMoreRetry`.

## ⭐ Grill me before planning — the control outside a run, the grilling in a question-only conversation, and the plan offer held, then shown with what was settled (2026-10-23)

**Design system — read first.** Files read: `package.json` (depends on `@motir/design-system` `workspace:*`, version `0.17.0` in `packages/design-system/package.json`) and `app/globals.css` (imports `@motir/design-system/theme.css`). **Verdict: ON MOTIR DESIGN.** The axes are the project's own (`app/layout.tsx` sets `data-style` / `data-palette` / `data-type` from the applied appearance), drawn here at the defaults the lifted sheets carry. The mock is drawn the way this area draws a delta: the stylesheet of the published _Grill me — questions before planning_ design lifted verbatim, the plan offer mock's `.po-*` block appended verbatim, and one small token-only `.gb-*` block — so a reviewer can diff each composed part against the design it came from. Every part is the package's (`Switch`, `Popover`, `Button`) or the project's own (`Bubble`, the `ReplyRow`, the sharpen summary's line, the plan offer panel, `AiPaywall`); nothing is missing, so nothing is proposed as an addition.

**A DELTA.** The mock is **`design/ai-chat/grill-before-planning.mock.html`**. It composes, by reference and without redrawing them: the published design _Grill me — questions before planning_, panels **G1–G7** (the control in the composer's `beforeField` row and its "?" popover, the opening marker and act line, the asking bubble and `ReplyRow`, answers, Skip / You decide, the summary's line style, the error block; that design's notes section and its mock are on its published design result, not in this repository), and § _The plan offer on an answer turn_ above (`design/ai-chat/plan-offer.mock.html`): the panel, its no-target line, Confirm, Decline, the helper line, the confirmed block and the cannot-start line. It amends neither mock. It does not redraw the bug offer, or Grill me inside a run, which stay as shipped.

**The access path** is the Pre-planning Grill me control, drawn in the composer, off and on (panel 1). The planning overlay itself is reached the shipped ways.

### What changes, in one sentence

With Grill me on in a conversation that has no plan yet, an answer that would offer to plan opens a grilling first; the offer is held — no Confirm, no Decline — until the grilling ends, and then appears naming what the answers settled.

### The five named elements

| Element                                             | Where                                                                                                                   | What is drawn                                                                                                                                                                                                                                                                                                                                                                            | Tokens                                                                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pre-planning Grill me control**                   | the composer's `beforeField` row, exactly where a run's conversation phase draws it                                     | the shipped `Switch` + _Grill me_ + "?" (G1). Two changes while the conversation has no plan: the "?" popover gains a last paragraph, and the pre-planning hint replaces the shipped _Your next message starts the grilling._ (false here: a defect report, or an answer with no offer, starts no grilling). Inside a run both stay as shipped.                                          | hint 12px `--el-text-secondary` on `--el-surface`; popover paragraph `--el-text-secondary` on `--el-surface` (as G2)                                                                                                         |
| **Grilling thread in a question-only conversation** | inline in the conversation, after the person's request and the grounded answer                                          | the shipped thread: opening marker, the `reading` act line while the first question loads, the asking bubble with its readings, the `ReplyRow` (readings, _Something else…_, _Skip_, _You decide_, _Stop grilling_), the person's pick as their turn. The grounded answer is drawn whole **without its offer panel**; its meta line stays.                                               | as G3–G6                                                                                                                                                                                                                     |
| **Held offer notice**                               | under the thread, aligned with the bubbles (36px)                                                                       | the pause glyph and one line, `role="status"`. **No Confirm or Decline is drawn anywhere while a grilling is open.**                                                                                                                                                                                                                                                                     | `.gb-held`: 12px, `--el-text-secondary`; glyph `currentColor`, `aria-hidden`                                                                                                                                                 |
| **Settled-answers plan offer**                      | at the end of the thread, under the closing marker — the answer turn's held offer, revealed where the person is reading | the shipped plan offer panel with one new block between the target/no-target row and the actions: the heading, then one line per settled answer in the shipped summary's line style — the person's answers on the accent rule tagged _You answered_, the planner's assumptions on the dashed rule tagged _Planner's assumption_. Confirm, Decline and the helper line follow, unchanged. | heading 600 12px `--el-text-secondary`; line rule `--el-accent` / dashed `--el-border-strong`; question 12px `--el-text-secondary`; answer 13px `--el-text`; panel `--el-surface`, `--radius-card`, `--spacing-card-padding` |
| **Nothing-to-ask end**                              | the closing turn, then the offer                                                                                        | the conversation-scope nothing-to-ask line as a Motir AI turn, then the offer **at once with no settled list** — the clear-enough line (check glyph) in the list's place. The same slot carries the nothing-settled line when a grilling is stopped or switched off before any answer.                                                                                                   | `po-rule`: 12px `--el-text`, 2px `--el-border-strong` rule                                                                                                                                                                   |

**The settled list is drawn once — on the offer.** In a conversation scope the thread's ended summary card (_What you settled_) is not drawn: its write-back lines (_Writing your answers to the plan's requirement…_, _Written to the plan's requirement._) and _Nothing was written._ do not apply before a plan exists, because nothing is written until the person confirms. The thread ends on its closing marker and the offer appears under it.

### States — the storyboard

| Mock panel  | State                                             | What is drawn                                                                                                                                                      |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 · left    | Grill me off, before planning                     | the control off; the grounded answer carries the plan offer with no question — unchanged from § _The plan offer on an answer turn_                                 |
| 1 · right   | Grill me on, no request yet                       | the control on, the pre-planning hint; composer empty; nothing held                                                                                                |
| 2 · left    | the "?" pressed                                   | the shipped popover with the extra last paragraph                                                                                                                  |
| 2 · right   | no `ai:plan`                                      | no control and nothing held; grilling needs no `work_item:edit`                                                                                                    |
| 3 · left    | an offer is about to be made                      | the answer without its offer panel, the opening marker, the shipped `reading` act line, the Held offer notice                                                      |
| 3 · right   | grilling open — question turn                     | the asking bubble, the `ReplyRow`, the Held offer notice; no Confirm or Decline                                                                                    |
| 4 · left    | answered, waiting for the next question           | the pick as the person's turn, the act line loading the next question, the notice                                                                                  |
| 4 · right   | typed _yes_ or _confirm_ while a grilling is open | an ordinary answer to the open question — drawn as a typed answer, the next question loads; no state change                                                        |
| 5 · left    | ended by finishing                                | the shipped _That's everything I needed to ask._ marker, then the Settled-answers plan offer with the full list                                                    |
| 5 · right   | typed _yes_ (or Confirm) while the offer is shown | the shipped confirmed block (the settled list stays as the record); planning starts below, in this conversation; the control is gone, as it is once any run starts |
| 6 · left    | ended by Stop, some answers settled               | the shipped _You stopped the grilling._ marker, then the offer listing only what was settled                                                                       |
| 6 · right   | ended by Stop, nothing settled                    | the conversation-scope stopped marker, then the offer with the nothing-settled line in the list's place                                                            |
| 7 · left    | ended by switching Grill me off mid-grilling      | the Grill-me-off marker, then the same offer as Stop; the switch is off                                                                                            |
| 7 · right   | ended by nothing to ask                           | the conversation-scope nothing-to-ask line, then the offer at once with the clear-enough line                                                                      |
| 8 · left    | a failed grilling turn                            | the shipped error block with _Try again_; _Stop grilling_ under it; the offer stays held                                                                           |
| 8 · right   | out of credits during a grilling                  | the shipped out-of-credits state (`AiPaywall`) in the question's place; _Stop grilling_ stays and shows the offer                                                  |
| 9 · left    | an offer that cannot start                        | as the plan offer design draws it: one Motir AI cannot-start line, no panel; **no grilling opens**, nothing is held                                                |
| 9 · right   | a defect report with Grill me on                  | the grounded answer and the bug offer as its own design draws them; no grilling                                                                                    |
| 10 · left   | a targeted _plan this_ with Grill me on           | planning starts at once; nothing held, no notice; the run's own grilling follows as shipped                                                                        |
| 10 · middle | reopened within 30 minutes                        | the same conversation with the open grilling exactly where it was left; the switch state is kept per conversation, as in a run                                     |
| 10 · right  | reopened after the lease ended                    | the shipped ended-conversation state; nothing is offered                                                                                                           |
| 11          | Chinese                                           | every new string in zh; lines wrap inside their rule or under their glyph, nothing truncates                                                                       |
| 12          | dark                                              | the held question and the settled offer on `data-theme='dark'`                                                                                                     |

**The sequence stays consistent with Stop, Grill me off and the lease.** Every way a grilling ends — finishing, Stop, switching Grill me off, nothing to ask — shows the same offer; only its list differs (full, partial, the nothing-settled line, the clear-enough line). An error or out-of-credits turn never shows the offer by itself: the person ends the grilling, or tries again. A conversation reopened inside its lease keeps the grilling open and the offer held; one reopened after it is ended, and holds nothing.

### Copy — en and zh

New strings, and the conversation-scope variants of shipped strings. Every other string is the shipped one (`planChange.grill.*`, `sharpen.*`, `planChange.planOffer.*`).

| Role                                                                                           | en                                                                                                                  | zh                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| the "?" popover, extra last paragraph (no plan yet)                                            | Before any plan exists, Motir AI asks its questions before it offers to plan, and the offer shows what you settled. | 还没有计划时，Motir AI 会先提问，再提议规划；提议会列出你确定的内容。 |
| the pre-planning hint (replaces _Your next message starts the grilling._ while no plan exists) | When Motir AI would offer to plan, it asks its questions first.                                                     | Motir AI 要提议规划时，会先提问。                                     |
| the Held offer notice                                                                          | Motir AI will offer to plan when these questions are done.                                                          | 这些问题问完后，Motir AI 会提议规划。                                 |
| the settled-list heading on the offer                                                          | What your answers settled                                                                                           | 你的回答确定了这些                                                    |
| the clear-enough line (nothing to ask)                                                         | Clear enough to plan as stated.                                                                                     | 已足够清楚，可以按原样规划。                                          |
| the nothing-settled line (Stop / Grill me off before any answer)                               | Nothing was settled, so the request is planned as stated.                                                           | 没有确定任何内容，所以会按请求原样规划。                              |
| the nothing-to-ask line, conversation scope (replaces _…I'm writing the plan now._)            | I have nothing to ask — this is clear enough to plan as stated.                                                     | 没有需要问的：这已经足够清楚，可以按原样规划。                        |
| the stopped-before-any-answer marker, conversation scope (drops _Nothing was written._)        | You stopped the grilling before any answer.                                                                         | 你在回答任何一问之前停止了追问。                                      |
| the Grill-me-off marker (switched off mid-grilling)                                            | You turned Grill me off, so the questions stopped.                                                                  | 你关闭了追问我，所以提问已停止。                                      |

Unchanged and reused: the opening marker, _That's everything I needed to ask._, _You stopped the grilling._, the question label, _Recommended_, the `ReplyRow` labels, _You answered_ / _Planner's assumption_, the error line and _Try again_, the plan offer's label, no-target line, Confirm, Decline, helper and confirmed block.

### What this section does not change

- Grill me inside a run, the run's own grilling and its summary with write-back — as shipped.
- The plan offer panel's own states (§ _The plan offer on an answer turn_) — a held offer, once shown, is that panel in every state it draws.
- The bug offer, and a targeted _plan this_ — neither is ever held.
- Which code builds which element; the server's door and storage for a conversation-scope grilling.
