# `design/runs/` — watching an agent work

The design area for **agent runs**: the record of what a dispatch run did, and the surfaces a person
watches it on. New area, created by **Story MOTIR-1789 · MOTIR-1795**.

A run is the thing Motir has never been able to show. Someone hands it a whole story, eleven work
items go _In Progress_ at once and stay that way for an hour, and the complete account of which one
is being worked, which were skipped and why, and where it stopped exists in a terminal on one
machine and is gone when the window closes. These surfaces are that account, in the product.

---

## ⚠️ THE NOUN IS `work item`, NEVER `card`

Every rendered string in this folder — a column head, an empty state, a sentence on a panel — says
**work item** or **item**. That is the product's noun, in its API, its documentation and its
interface; _"card"_ is the planning corpus's authoring shorthand, and it reached this area's copy
through these mocks, because **a mock is not a sketch: it is the copy, verbatim, and a code work item
transcribes it into `messages/*.json`.**

**Three senses, and only the first is wrong here.** A WORK ITEM (fix it) · a UI PANEL — `Card`,
`ContentSectionCard`, `.secCard` — which keeps its name · a quoted SOURCE SYMBOL —
`DispatchRunCard`, `DispatchCardDisposition`, `card_claimed` — because the schema is not copy and
renaming a shipped symbol is a different job. So the sweep is a disposition per occurrence, never a
substitution: a blind replace ships _"we couldn't charge your work item"_ on some other surface.

Measured at `origin/main` `2fc5d6016`, before the sweep: `design-notes.md` 55 · `run-section.mock.html`
87 · `run-view.mock.html` 81 · `runs-index.mock.html` 58. Recorded on MOTIR-3893; the rest of the
product's catalog carries the same noun in ~14 more strings and is MOTIR-3949.

**The accounting AFTER the sweep, so a later reader can re-run it rather than trust it.** Strip the
`<style>` blocks, the comments and the SVG, unescape, and grep the remaining text for `\bcards?\b`:

| asset                   | rendered hits | what they are                                                |
| ----------------------- | ------------: | ------------------------------------------------------------ |
| `run-modal.mock.html`   |         **0** | —                                                            |
| `runs-index.mock.html`  |         **0** | —                                                            |
| `run-section.mock.html` |         **1** | `Card and Pill` — the two UI primitives the section composes |

**⚠️ AND A WARNING FOR WHOEVER SWEEPS THIS FOLDER NEXT, because it cost a render to find.** A CSS
CUSTOM PROPERTY is a fourth sense of the word, and it is the one a careless sweep destroys:
`--radius-card`, `--el-card`, `--shadow-card`, `--spacing-card-padding`, `--el-card-icon-bg`,
`--el-card-icon-fg`. Rewriting those produces a file that still parses, still has every panel, and
renders **792 CSS px shorter** because no radius, shadow or padding resolves any more.

**It is invisible to the obvious check.** The probe below, written to list every occurrence with its
surrounding token, cannot match `--radius-card`: the separator is a HYPHEN and the hyphen is not in
the character class. The accounting comes back clean while the asset is broken.

```
the probe that missed it     [A-Za-z_.`]*card[A-Za-z_.`]*
what it cannot match         --radius-card   --el-card   --shadow-card
mask these FIRST             --[a-z0-9-]*card[a-z0-9-]*
```

**Mask every CSS custom property first, and verify with a pattern that includes hyphens** — then
check the RENDER. A copy-only edit must reproduce the committed height exactly, which is what
`EXACT` with `committed=2400x17114` and `new=2400x17114` on this asset now says.

---

## The surfaces

| Surface                                                                                                                           | Asset                                           | What it settles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The run SECTION on a work item**                                                                                                | **`run-section.mock.html`** + `run-section.png` | The work item's own run: its live timeline over the CARD-SCOPED event vocabulary, the "one of N" link-out when the run covers a set, this work item's recent runs as a paged list, and the collapsed log console. Every terminal state, including the two that get improvised when undrawn — **re-planned** and **reporting-offline**. **Also carries this area's TONE TABLE** (panel 12), which every other run surface consumes. MOTIR-1795 (design). Gates MOTIR-1796.                                                                                                          |
| **The RUNS INDEX** (`/runs`)                                                                                                      | **`runs-index.mock.html`** + `runs-index.png`   | Every run the project has made, current and past, and **the rail row that reaches it**. The surface that makes a run FINDABLE at all — it is what replaced the `/ready` strip this area used to draw (below). MOTIR-3893 (design). Gates MOTIR-3923.                                                                                                                                                                                                                                                                                                                               |
| **A container's OWN runs** — the door on its item page, and `/runs?scope=<KEY>`                                                   | **`run-scope.mock.html`** + `run-scope.png`     | The runs a work item was the SCOPE of, which its own Run section cannot show because a scoped run's legs are the CHILDREN. The door in all three cases (scope only · both · never), the index narrowed to one scope, the address contract that keeps `?scope=` across opening and closing a run, every face of the narrowed page (empty · a key that resolves to nothing · an archived scope · wait · failure), and the runs `?scope=` can never address. COMPOSES `run-section.mock.html` and `runs-index.mock.html`; defines nothing new. MOTIR-5402 (design). Gates MOTIR-5363. |
| **The run MODAL** (over `/runs`)                                                                                                  | **`run-modal.mock.html`** + `run-modal.png`     | One run, FULL SCREEN over the list rather than at a route of its own: the header, the **reused canvas** carrying every work item the run owns with its disposition in this run, and the **log pane** carrying what the agent is saying. All three set shapes, the skips with their reasons, the run's own states, and the log pane's three distinct silences. COMPOSES `design/roadmap/`'s canvas and this folder's tone table; defines neither. MOTIR-3893 (design). Gates MOTIR-3895 and MOTIR-3962.                                                                             |
| **The fix part's THIRD DOOR** — Fix in my agent, in the Development block, the ended run's modal header and the Hosted agent room | **`development--fix-in-my-agent.mock.html`**    | The door offered, preparing, in progress, refused, fell back and gave up; the auto-fix setting row. Gates MOTIR-9053, MOTIR-9047, MOTIR-9060, MOTIR-9054, MOTIR-9056. § _Fix in my agent_ below.                                                                                                                                                                                                                                                                                                                                                                                   |

### ⚠️ WHAT THIS AREA DREW ONCE AND WILL NOT DRAW AGAIN — the `/ready` run STRIP

An earlier revision of this area carried a third surface: `ready-strip.mock.html`, a live-run
indicator on a `/ready` row, drawn in both states and measured to cost the row no height. **It is
deleted, and the reason is not taste — the row it decorated cannot occur.** `/ready` renders
`workItemsService.listReady`, whose `collectReadyLeaves` collects only _the ready, childless `todo`
leaves_, and `claimNextReady` / `claimScope` flip every claimed work item to `in_progress` **before** the
first agent starts. A work item with a live run has therefore left the list the strip lives on, by
construction — the transition that creates the state worth indicating is the transition that removes
the row.

The asset had noticed half of this and stopped one step short: its own state table said _"a finished
work item has left the ready set, so no strip state exists for it"_, which is the same sentence one word
away from being true of a RUNNING work item.

**What the strip was FOR is now the runs index**, which is reachable from the rail rather than from
the one page a run's work items have just left. Recorded on MOTIR-3914; the archived work item is MOTIR-1797.

### ⚠️ AND THE SECOND — the run VIEW as a PAGE, `/runs/[id]`

`run-view.mock.html` drew one run as its own route: a header, a seven-column table of the set, and
the run's states. **It is deleted, and this time the reason is the INTERACTION rather than an
impossible state.** Yue, on reading it (2026-08-29): _"click a run to show a full screen modal,
canvas on the left to show the work item status, reuse the canvas, right side to show the log panel. it's
full screen but not a new page, close to show the run list page."_

A run is something you look INTO from the list and come back out of. A route makes that a
navigation: it loses the reader's scroll position and their current/past partition, and turns a
glance into a round trip. **The overlay keeps both** — `/runs` stays mounted behind it — and it gives
the canvas the room a seven-column table was being squeezed into.

**Where each of that asset's facts went, so nobody redraws it looking for one:**

| the page drew                                 | it now lives                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| the header (command · scope · agent · timing) | the modal's own header, unchanged                                                |
| the SET as a table                            | the modal's **canvas pane**, composed from `design/roadmap/`                     |
| a per-row DELIVERY reference                  | nowhere — a node LINKS to its work item, whose Development section owns delivery |
| the run's states                              | the modal, drawn per state                                                       |
| the way BACK to the index                     | close · `ESC` · Back, drawn as three real exits                                  |
| **nothing at all**                            | **the LOG pane** — the half that was missing, and the whole complaint            |

**It is worth recording WHY the gap was invisible.** The page was buildable, correctly sized,
correctly blocked, and every comparable product in the category ships one — a CI provider, a
deployment platform, a build service. Measured on the merged assets at `origin/main` `2fc5d6016`:
`run-section.mock.html` drew the log console **26** times and `run-view.mock.html` **none**. The
surface a person would open to watch an agent work could show that something was running and never
what it was doing. Recorded on MOTIR-3952; the re-scoped work item is this one.

---

## What this area does NOT draw

Three boundaries, each because the fact already has an owner and a second drawing of it is how one
product acquires two answers to one question.

1. **Pull requests and their CI belong to the DEVELOPMENT section.** One work item up the same stack,
   drawn at `design/work-items/delivery-set.mock.html`. The run section names a pull request in its
   timeline as an EVENT — _"pull request linked"_ — and draws no state for it. `run-section.mock.html`
   panel 11 draws the two adjacent so the relationship is legible; that panel is the whole of what
   this area says about a pull request.
2. **The work item's STATUS belongs to the board.** A run is not a status and must not read as one.
   This whole area exists _because_ the status column has stopped being able to answer — a scoped run
   puts eleven work items at _In Progress_ simultaneously, so the column reports the run's footprint and
   not its cursor — and a run surface that looked like a second status pill would be re-drawing the
   thing it exists to compensate for.
3. **Tokens, usage and cost are not drawn at all**, and not because they are "not yet": a BYOK run
   never touches the gateway and has no cost. See _Out of scope_ below.

## What it composes

| Host                                                                           | Composed how                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `design/work-items/` + `app/(authed)/items/[key]/_components/LateSections.tsx` | The run section is a **new row in the item page's tier table** (below). It is `ContentSectionCard`'s header grammar over `Card`, in the LATE STACK. The host's layout, header, rail and navigation are cited, never re-specified.                                                                                                                                                          |
| `app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx`           | Both PAGES compose that file's shipped table grammar — a rounded, bordered, horizontally scrollable wrapper over a plain table, secondary ink in the head and body ink in the cells. Copied, not re-invented; the run tables are not a new component.                                                                                                                                      |
| `design/roadmap/` + `components/planning/ProjectRoadmapCanvas.tsx`             | The modal's LEFT pane MOUNTS the shipped project canvas. Its pan, zoom, drill, search, locate, saved layout and the work-item node's look are that area's and are CITED, never re-specified here; this folder draws only the disposition strip a RUN adds to a node. Build the level through `workItemLevel.tsx`'s adapter — a cast from the run DTO renders invisible nodes (MOTIR-3152). |
| `design/shell/` + `app/(authed)/_components/SidebarNav.tsx`                    | The rail is drawn ONLY so the access path is visible rather than described. Its rows are the shipped sidebar's shape and the entry follows that file's own convention; nothing about the rail itself is re-specified here.                                                                                                                                                                 |

---

## Placement: the run section joins the late stack, BEFORE Development

`design/work-items/design-notes.md` § _The item page at ARRIVAL, and while it STREAMS_ allocates the
page in three tiers. The run section is a **sixth late region**, and its row in that table reads:

| Region                                                   | Tier               | Its pending face                                                              |
| -------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| **Run (this work item's live run, and its recent runs)** | **AFTER the page** | **work item chrome + row-shaped pulse bars — the same face Development uses** |
| Development (linked PRs + CI)                            | **AFTER the page** | work item chrome + row-shaped pulse bars                                      |
| Acceptance                                               | **AFTER the page** | work item chrome + a two-line body pulse                                      |
| Design result                                            | **AFTER the page** | work item chrome + a thumbnail-shaped pulse                                   |
| Attachments                                              | **AFTER the page** | tile-shaped pulse skeletons                                                   |
| Activity                                                 | **AFTER the page** | comment-row-shaped pulse skeletons                                            |

**Directly BEFORE Development, and the argument is CAUSAL ORDER rather than mere adjacency.** The
run is what PRODUCES the pull request. Reading down, a person meets _an agent worked this card_ and
then _and here is what it shipped_ — the order the events actually happened in, and the order the
run's own timeline ends in, since **_pull request linked_ is its second-to-last row**. Reversed, the
page shows the artefact above the act that made it, and the reader has to scroll past a merged pull
request to find out where its branch came from. The two still share a boundary of meaning, which
panel 11 draws explicitly; what changed is which side of it comes first.

_(Yue, 2026-08-29: the first revision put the run section after Development and argued adjacency.
Adjacency was the right property and the wrong side of it — "run first, then the PRs are there".)_

**⚠️ IT FILLS WITH THE ONE SETTLE. It is not a sixth arrival.** The host decides that the page
settles TWICE — once when the first content replaces the frame, once when the late stack fills — and
that the late regions therefore share ONE `<Suspense>` promise rather than one each. A sixth
independent boundary would make the page settle three times for a region that is below the fold at
arrival: the wait it saves is a wait nobody is watching, and the cost it pays is a reader who scrolls
into a mixture of real and pending sections and cannot tell which is which. The run section's pending
face is therefore the stack's own, and its read joins `lateReads`.

_(The host's note on why "one settle" is delivered by TWO boundaries — `ChildPanel` is tier 2 and
renders between Design result and Attachments — is unchanged and is not restated here.)_

---

## The CONNECTION — SSE, and only while a run is live

**No WebSocket, anywhere in this area.** The transport is **Server-Sent Events** — one long GET on
`/api/dispatch-runs/[id]/stream`, resumable from `?since=<seq>` — chosen because the traffic is
strictly one-way (the page reads a run; it never writes to one) and because the product already has
exactly this convention in `app/api/ai/plan/generate/[jobId]/stream/route.ts`. A second streaming
mechanism would mean two heartbeat intervals, two frame formats and two sets of proxy-timeout bugs
to learn about separately.

**⚠️ AND THE SECTION OPENS NO CONNECTION AT ALL UNLESS THIS CARD HAS A LIVE RUN.** This is the rule
that decides what the panel COSTS, and it has to be written down because the obvious implementation
gets it wrong: a section that subscribes on mount opens a stream on **every item page a person
opens**, and the overwhelming majority of work items are not being worked. The item page is the most
visited surface in the product.

So, per state:

| what the work item has        | what the section does                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| no run ever                   | renders the empty state. **No stream.**                              |
| only finished runs            | renders the history from the page's own read. **No stream.**         |
| a run in a NON-terminal state | opens the stream, resuming from the last `seq` it holds              |
| that run reaches terminal     | the server writes `done` and **closes**; the section does not reopen |

The server half already refuses to hold a pointless connection — an already-terminal run replays
from the cursor and closes rather than parking a socket — but that only bounds the damage after the
connection exists. **The client must not open one in the first place**, and the fact it needs is
already on the page: the history read's first row IS the current run, so whether a stream is owed is
answered by data the section has before it renders anything.

The **stream-reconnecting** state (panel 7) is what a dropped connection looks like _while a run is
still live_; it is a transport state, not a run state, and it is never shown for a work item at rest.

---

## The ACCESS PATH — `/runs` is a primary rail entry, directly after Ready

**The verdict, and the reading that settled it.** An earlier revision of the run-view work item
pre-judged this as _"the expectation is no primary-nav entry"_. That expectation was wrong, and it
was wrong for a reason worth keeping: it was made while a `/ready` strip still existed to be the
door, and when the strip turned out to be undrawable the run view was left with no general
entrance at all.

Read against `design/shell/design-notes.md` and the shipped convention in
`app/(authed)/_components/SidebarNav.tsx`: **every top-level project view is a primary entry** —
Home · Dashboard · Issues · Ready · Boards · Roadmap · Plans · Backlog · Triage · Reports — and each
carries a source comment naming the design section that grounded it (Roadmap's says its own entry is
_"drawn beside the other project nav surfaces; NOT a Board↔Roadmap toggle"_). A runs index is a peer
of those, so it takes the same first-class row.

**Position: directly after Ready.** _Ready is where you dispatch; Runs is where you watch._ The two
are one action apart, and putting Runs at the end of the rail would separate them by six rows for no
reason a reader could reconstruct.

**Glyph: `Waypoints`** — a path through ordered nodes, which is exactly what a run over a SET is, and
it is unused in the rail. Ruled out, each because it is already taken and a second meaning for one
glyph is worse than a less obvious first: `CirclePlay` (Ready), `Zap` (the epic issue type),
`Activity` (Code health), `History` (Resume onboarding).

**⚠️ The row must be REGISTERED as well as rendered.** `lib/settings/projectNavAccess.ts` carries one
row per nav href with a permission requirement and an evidence sentence, and its own header records
that `canOfferNavDestination` answers **FALSE for an href it does not carry** — so an omission does
not fail loudly, it drops the row from the rail. A page that ships, renders and passes its tests can
still be invisible. The requirement is **`browse-only`**, because the read's own gate is
`projectAccessService.assertCanBrowse`: a run history is project data, and whoever may see the
project may see what ran in it — the same answer the two sibling run reads already carry in the
permission inventory.

---

## The PAGE and the OVERLAY, and what each settles

### `/runs` — the index

**Two headed sections, not a switch and not one undivided list.** A person arrives asking one of
exactly two questions — _what is happening right now_ or _what happened_ — and the two are read
differently: the first is watched, the second is searched. Two sections answer both without a click
and without hiding either. Live runs are few by construction (bounded by how many agents are
running), so the top section is short and the page does not fight itself. **When one side is empty it
says so in a line rather than disappearing**: a section that vanishes makes a reader wonder whether
it failed.

**The row** carries the command, the scope, the agent + model, when it started, elapsed-or-duration,
the status pill, and the **leg summary** — _"9 of 11 implemented, 1 skipped, 1 not reached"_ — which
is the run's outcome in one cell. **The stop reason is deliberately NOT in the table**: it is one
sentence and it belongs on the run, where there is room to say it in words.

**Two rows a list of records has to survive, drawn in panel 4.** A run that took **no work items** (a real
outcome — a scoped run whose members were all skipped) and a run whose **scope work item was
deleted** (the row survives it; the record stores the scope LABEL beside the id precisely so a run
stays readable after its subject is gone). Neither is styled as a problem.

**The wait and the failure are separate faces** (panel 5). _We could not load this_ and _nothing has
run_ are opposite facts and must never share one. The frame is **an in-page `<Suspense>`, never a
`loading.tsx`**. ⚠️ That rule used to be justified here by `/runs/[id]` — a route-level boundary
would sit above it, flush the response head and turn its 404 into a 200 — and **that route no longer
exists**, so the reason went stale when the run view became an overlay. The rule stands on the
decision that was always the load-bearing one: `design/shell/design-notes.md` § _the
navigation-pending grammar_ settles it for the whole group — every page's frame is its own in-page
`<Suspense>`, placed after the page's own gate, and **no `loading.tsx` is added under
`app/(authed)`** at all. `tests/navigation/loading-boundary-guard.test.ts` keeps its known-debt list
empty.

### The run MODAL — full screen over `/runs`, opened from a row

**It is an OVERLAY, and the list stays mounted behind it.** Closing returns the reader to the same
scroll position and the same current/past partition, which is the whole reason it is not a route.
**Three exits, all real:** the close control, `ESC`, and Back — the last of which works because the
deep link is a `shallowPush` that keeps a history entry.

⚠️ **The canvas has its own keyboard handling** (`/` to search, zoom, locate), and a full-screen
canvas inside a dialog is exactly where two `ESC` handlers collide. The dialog's must win, and a test
must say so rather than a reader discovering it.

#### The DEEP LINK is `/runs?run=<id>`, and THREE files have to agree on it

The run SECTION on a work item points its _"one of N"_ line and every run-history row at it; the runs
INDEX writes it when a row is activated; the modal reads it. That is three files and one parameter
name, so it is recorded here rather than in whichever of them is written first.

It is a `shallowPush`, never a `router.push`: `CLAUDE.md`'s discriminator is whether the target body
needs data the browser does not have, and the modal fetches its own run client-side — so the server
has nothing to answer and re-running the page is pure cost.

#### The CANVAS pane COMPOSES `design/roadmap/` — it does not redraw it

`ProjectRoadmapCanvas` (MOTIR-1194) is the shipped foundation every planning surface mounts, and
`design/roadmap/` is where its pan, zoom, drill, search, locate, saved layout and the work-item
NODE's look are drawn. **This asset draws the node only far enough to show what a RUN adds to it: the
member's disposition in this run, on a strip below the node's own content.** A design that
re-specified the canvas would give the product two accounts of one component, and they would drift —
which is this folder's own reuse rule applied one surface over.

**The LEVEL the pane serves is the run's SET, as one synthetic level.** A run's members are not one
parent's children: `motir batch` and `motir auto` take whatever was ready, across parents. The canvas
takes a consumer-supplied `loadLevel`, and serving a synthetic level through it is the established
pattern in that component's own family — `workItemLevel.tsx` exports `ORIGIN_ID` precisely because
_"`loadLevel` intercepts this id and serves the synthetic pre-plan station level for it"_.

⚠️ **The ADAPTERS are the reuse, not the route** — bug MOTIR-3152, written into
`PlanReviewCanvas.tsx`'s own header. `DispatchRunCardDto` carries `key` / `disposition` /
`skipReason`; `ProjectCanvasNode` needs `content` / `searchText` / `drillable` / `crumbLabel`. They
share no field name, and a cast from `unknown` type-checks, so every node arrives with an undefined
`content` that renders into a zero-height box: _"the work item was not blank, it was INVISIBLE"_. Build
the level through `workItemLevel.tsx`'s adapter, and extend the adapter where a run needs something
it does not carry.

**Which of the canvas's opt-in controls are on is a DECISION, not a default.** `searchable`,
`locatable`, `fullScreenable` and `emphasis` are each absent unless passed. `fullScreenable` is
**off** here: escalating to the Fullscreen API from inside a dialog that already fills the screen is
two overlays and two `ESC` handlers, which is the collision above made worse rather than solved.

**Selecting a node is what the log pane filters to.** The selection lives in the modal and is passed
to both panes, so neither owns the other's state.

#### ⚠️ THE RUNNING EDGE — the run TRAVELS along it (Yue, 2026-08-30)

**This is why the pane is a graph rather than a table.** A table can say _this one is running_. Only
the graph can say **what becomes reachable when it lands**, and on a run that is the question a
person actually has — the order is not arbitrary, it is the dependency edges, and watching a run is
watching the frontier move along them.

**Every edge FROM the running work item TO one it BLOCKS flows**, in the running tone this area
already owns (`--el-status-in-progress`). The canvas already draws the arrow blocker → blocked, so
the motion travels the way the work does and needs no second direction cue.

**Only `running` flows.** A queued node's edges are dependencies, not travel; a finished run has
nothing in motion, so it reads as a still graph — which is the correct picture of a run that has
stopped. Nothing else on the surface animates.

**⚠️ REDUCED MOTION IS REQUIRED, NOT A COURTESY.** This surface is left open for an hour at a time,
and a looping animation with no still state is a vestibular hazard and an attention sink. Under
`prefers-reduced-motion: reduce` the edge keeps its WEIGHT and its HUE — it still reads as the live
one — and stops travelling. Drawn beside the moving face in panel 2, not described.

**⚠️ AND IT NEEDS A CAPABILITY THE FOUNDATION DOES NOT HAVE.** Verified on `origin/main`:
`CanvasEdge.variant` in `components/planning/PlanningCanvas.tsx` is a closed union — `firm` ·
`pending` · `cross` — and the CONSUMER supplies edges while the FOUNDATION renders them, so a run
pane cannot animate an edge it does not draw. Two constraints on that change, both read from the
file rather than assumed:

- **The animation must ride the SAME `<path>`.** That component keeps its arrowhead markers in a
  separate `<svg>` on purpose, so that _"the canvas-edges `<path>` count stays = the edge count"_ —
  a second element per edge breaks the guard asserting it. An animated `stroke-dashoffset` on the
  existing path satisfies both.
- **FIVE files compose this foundation** — `ProjectRoadmapCanvas`, `PlanningWorkspaceHost`,
  `PlanningWorkspaceSkeleton`, `DiscoveryOnboarding`, `StationNode` — so widening the union is a
  shared change, and the new member must be opt-in exactly as `searchable` / `locatable` /
  `fullScreenable` are. An onboarding canvas that grew a flowing edge would be a regression.

**That is a build dependency, not a note, and it has a KEY: MOTIR-3972** — `PlanningCanvas` learns
the animated variant, and [the run modal](motir:cmteb0tj2001ohvn82ijisqz7) is `blocked_by` it. It is
carved rather than folded into the modal's own card, which is already at the estimation gate's
ceiling: the design gives that card more than it was sized for, and the honest answer to that is a
split, never a bigger number.

**The split also says who owns WHICH decision.** MOTIR-3972 makes the variant available and correct
— the flowing dash, its own arrowhead marker, the reduced-motion rule, and the opt-in default that
keeps every other consumer byte-identical. It chooses no policy. **This asset and the run modal
choose the POLICY**: which edges carry it (running → blocked, and only those), and when nothing
does (a queued node, a finished run).

#### The SET arrives in three shapes, and the pane is TOTAL over all three

A claimed scope (panel 1), a frozen batch snapshot (panel 2), and a **single work item** (panel 3) —
drawn as the same canvas with one node rather than as a different picture. A set of one is the
degenerate case of the same object, and the moment it gets its own layout the two drift and the
singular case becomes the one nobody maintains.

**The In-Progress-from-t=0 consequence is drawn as copy**, not left to the terminal. It is the one
property of this design a person must be TOLD rather than discover: every work item in a claimed
scope reads _In Progress_ on the board from the moment of the claim, while only one is worked at a
time.

**Only what the RECORD holds is drawn.** A batch's `newlyReady` group — became ready during the run
and deliberately not taken — has **no column**; `not_reached` is a disposition and `blocked_in_scope`
a skip reason, and those are the shapes available. A pane that drew a group the read cannot fill
would be specifying a schema change in a mock.

**Every word of the vocabulary is the shipped one**, and the notes name the source so a later reader
can check rather than trust: the stop reasons and their sentences from `packages/cli/src/autoLoop.ts`
and `packages/cli/src/batchPlan.ts` (`STOP_LABEL`), the skip reasons from `batchPlan.ts`
(`SKIP_LABEL`), the claimed-scope split and the In-Progress warning from
`packages/cli/src/scopedRun.ts` (`renderClaimedScope`).

**⚠️ AND ONE NUMBER IN THAT VOCABULARY IS NOT WHAT THE CLI FILE SAYS.** `batchPlan.ts`'s `SKIP_LABEL`
is `Record<SnapshotSkipReason, string>` and carries **six** reasons, so anything counting from that
file gets six — and the batch panel is right to draw six, because a snapshot cannot produce more.
**The RECORD's `DispatchSkipReason` has SEVEN**: the schema says outright that it is _"the union of
`SkipRecord.reason` and `SnapshotSkipReason`"_, and the extra member is **`blocked_in_scope`**, which
only a CLAIMED SCOPE can produce (the claim takes every member in the to-do category, `blocked`
included, which is not the same as being allowed to build one out of order — so such a work item is
_skipped and NAMED, never forced_). It is drawn in the claimed-scope panel, where it can occur,
rather than in the batch panel, where it cannot.

**This was found by the CODE, not by re-reading the asset** — MOTIR-1796's
`satisfies Record<DispatchSkipReason, string>` failed to compile on six, which is the whole argument
for writing these maps as `satisfies` rather than as a `switch` with a default. Every "six" in this
story's prose came from reading the batch file, and a surface total over six of seven renders the
seventh as nothing.

**It draws NO delivery.** The page this replaced showed a per-row repository / pull-request / CI
reference; the modal does not. A node LINKS to its work item, whose Development section owns delivery
and derives the one CI verdict in the product — and a second verdict on one screen is how two
surfaces start disagreeing about whether something is green. Removing it also removed the temptation
to keep a second CI vocabulary in step.

---

## The LOG pane — and its three silences are the load-bearing part

**The console treatment is `run-section.mock.html`'s**, reused rather than designed twice. What is
new is that it is a persistent pane rather than a collapsed strip, that it can be filtered to one
member or show the whole run, and that its EMPTY states carry more weight than its full one.

**Sending log bodies is opt-in and OFF by default**, enforced on the operator's own machine —
`motir help`: _"the machine that holds the content is the machine that decides whether it leaves."_
So the ordinary run has nothing here, and the pane must say why in a way that reads as the operator's
choice rather than as a failure to record.

| what happened                               | what the pane says                                               |
| ------------------------------------------- | ---------------------------------------------------------------- |
| the operator did not pass `--report-log`    | **their choice** — naming the flag is the whole remedy           |
| the run is live and has printed nothing YET | **waiting**, which is not the same as empty                      |
| the bodies were sent and have EXPIRED       | the **30-day** retention window did its job (`dispatchRunSweep`) |

One message for all three tells a person their run failed to record when in fact they chose that, or
when the record simply aged out. Collapsing them is the defect this table exists to prevent.

**Following releases the moment the reader scrolls up**, and an explicit control resumes it. A
console that yanks you back to the bottom mid-read is the classic version of this bug. Unfiltered,
each line names its source member and the order is `seq` — the RUN's order, not arrival order. A very
long line scrolls inside the console, never the page.

⚠️ **AND THE EDGE ITSELF NEVER DREW, for as long as this area has existed (found 2026-08-30).**
`.cvEdges` was `position: absolute; inset: 0` with no `width`/`height`. An SVG is a REPLACED element:
with no width/height attribute it takes its INTRINSIC size, and `inset: 0` does not stretch it the
way it stretches a div. **Every edge SVG in the asset was resolving to 16×16**, so every path drew at
about 4×6px and no edge — the running one included — was ever visible. Measured, not guessed: six
SVGs at `16x16`, and `543x315` / `461x208` once `width: 100%; height: 100%` was added.

⚠️ **AND THE ARROWHEADS WERE MISSING TOO** (Yue, 2026-08-30: _"without the arrow we don't know
which card is blocked"_). This is not decoration: the whole claim of the running edge is that it
points FROM what an agent is working TO what becomes reachable when it lands, and a plain line states
a relationship without a direction. The notes had asserted the arrow all along — _"the arrow already
points blocker → blocked"_ — while no `marker-end` existed anywhere in the asset. Every edge now
carries one, mirroring `PlanningCanvas`'s shipped markers exactly (same `viewBox`, `refX`,
`markerWidth` and `orient="auto-start-reverse"`), in their own `<svg>` for the same reason the
component's are: marker refs are document-global, and a second element inside `.cvEdges` would break
the path-count-equals-edge-count property its guard asserts.

**The IMPLEMENTATION was already correct** — `PlanningCanvas` has had a `running` marker filled
`--el-status-in-progress` since MOTIR-3972 and applies `markerEnd` to every edge. Only the design
asset was missing them, which is the same class of gap as the invisible SVG above: the thing the
notes claimed and the thing the file did had drifted apart, and nothing compared them.

Three consequences worth keeping, because they are the reason it survived review:

- **The path geometry had never been checked against the nodes**, since nothing was on screen to
  check. Every `d` was authored blind and every one was wrong — endpoints landing inside the target
  node, and one path that ran out of `MOTIR-1792`'s right edge and back into its own left edge. They
  are now derived from MEASURED node boxes, not estimated.
- **A `viewBox` + `preserveAspectRatio="none"` cannot be used here at all.** The nodes are positioned
  in CSS px, so the SVG must map one user unit to one px; a viewBox stretches the paths to the
  stage's real width while the nodes stay put. The viewBox is gone from all six.

⚠️ **The pane had no producer when it was drawn.** `DispatchEventKind.log` existed, the flag existed,
the strip and the sweep and the help text existed — and nothing in `packages/cli/src` ever emitted a
`log` event. MOTIR-3961 is the producer; without it this pane would have rendered its first silence
for every run, for ever, and looked correct doing it.

---

## What the run PRODUCED — the bug it filed and the plan it submitted

A run does two things that are not writing code, and they are the two most valuable things an
unattended run produces: it refuses a work item and submits a plan, and it files a bug for a defect
that was not its job to fix. `run-findings-protocol.md` Q1–Q4 gave it the right to do both.
**Q5 (MOTIR-3980) is what makes them visible**, and this section draws what Q5 permits — no more.

### WHERE it lives, and why not the two other places

**Pinned above the LOG, in the right pane** (panel 9), with a marker on the node in the canvas.

- **Not a band under the modal header.** A band spans both panes, so it pushes the canvas down on
  every run in order to serve the few that have anything to say.
- **Not only on the node.** The node answers _which work item produced it_; a reader arriving at a
  finished run is asking _what did this run produce_, and should not have to hunt a canvas for the
  answer.
- **The right pane is already the run's NARRATIVE column** — what the run said and what it printed.
  A strip there collapses to nothing without moving anything else on the screen.

Both are drawn because Q5 made the events **CARD-scoped**, so the record genuinely knows which leg
produced each finding. The strip and the node are the same fact at two zooms, and the node carries a
COUNT, never the strip's copy — it is an index into the strip, not a second copy of it.

### ⚠️ THE ABSENT CASE IS THE DEFAULT CASE, so it is drawn FIRST

Most runs produce neither. **A run that produced neither grows no region at all**: no heading, no
rule, no _"no findings"_ box — the log pane simply starts at the log. A region that is present and
empty on every ordinary run teaches a reader to skip exactly the place where the rare, important
thing eventually appears, which is worse than not having drawn it.

The one exception is **reporting-offline**, which is the only state where the strip appears with no
findings in it. _Silence_ and _the machine stopped reporting_ are different answers, and only one of
them means there was nothing to say.

### The PLAN in two states — an ASK and a piece of NEWS

They are the same object and completely different news, and if they look alike the more urgent one
is the one that gets missed.

|                          | what it is                                           | how it reads                                                                        |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **submitted, waiting**   | an ASK — nothing moves until a person decides        | the accent rule in `--el-status-planning`, and copy that says it is waiting for you |
| **approved by this run** | NEWS — it already happened, to the reader's own tree | no rule, no waiting language; a named list under one heading                        |

⚠️ **THE DISCRIMINATOR IS THE RULE, NOT THE PRESENCE OF AN ACTION.** Every finding on the strip
OPENS — a bug included. An earlier draft of this section made the ask the only row with a way in,
which distinguished the two by making the other rows useless: a finding a reader cannot reach is a
notification, not a finding.

Submitted-and-waiting is the COMMON case: auto-approval is opt-in and `auto`-only. Approved-by-this-run
is the one thing a run decides while nobody is watching, so it says so in the terminal's own words —
_"your tree changed while you were away."_

**⚠️ NAMED PLAN BY PLAN, NEVER A COUNT.** Not a preference: `autoLoop.ts` already settled it, in the
comment above the block that prints exactly this — _"A count would tell an operator that their tree
moved without telling them where."_ The surface prints the terminal's shape: the plan, the work item
it was approved FOR, and how many proposals it materialized.

**A re-plan is a CORRECT OUTCOME, not a failure.** `renderReplanSubmitted`'s first line says so —
_"this is a correct outcome, not a failure"_ — and a surface that rendered it in a failure tone would
teach people to distrust the most useful thing the loop does. It reuses this area's existing
`replanned` tone, deliberately neither green nor red. **No new tone is defined by this pass.**

### The BUG — additive, never collapsed, never dropped

A filed bug blocks nothing, claims no scope and did not end the run (Q3). The row says so by what it
does NOT carry: no status transition, no blocking language, nothing asking the reader to decide.

**⚠️ ADDITIVE IS NOT UNREACHABLE.** The row carries `Open →` like every other finding, and the
target needs nothing new to reach: `bug_filed.data` already holds the `key`
(`run-findings-protocol.md` Q5). The ONE row that does not open is the one whose target is GONE
(below) — silent about it, rather than offering a link into nothing.

**Several from one run stay separate rows.** _"3 bugs"_ loses the only thing a reader wants — which
three — and repeats the count mistake the approved-plans block already refuses.

**A closed or archived bug still renders.** The run found a real defect; somebody later triaged it,
and that is history this record exists to keep.

### ⚠️ A WORK ITEM'S STATUS IS NOT A RUN TONE — two vocabularies, two shapes

The pills on these rows (`Done`, `Declined`, `Archived`) are the **work item's or plan's own status**,
not a run disposition, and they are drawn as an outlined `wiPill` rather than the filled `runPill`
this area's tone table owns. This is not decoration: giving both vocabularies one pill shape is how a
reader starts reading a work item's `Done` as a statement about the RUN. The tone table above is
unchanged and gains nothing.

### Every state the record can be in

- **A DECLINED plan** keeps the run's own event wording and carries the plan's CURRENT status beside
  it. The run said _I submitted this_ and that stayed true; a person then said no. It is the most
  informative row on the page — never re-worded into a failure, never hidden.
- **A target that is GONE** — deleted, or not visible to this reader — renders from the event's own
  `data`, the key and title it recorded, with no link. ⚠️ **It is never dropped and never becomes an
  empty state**; both would tell the reader the run found nothing when it did. Same posture
  `dispatch_run_card.workItemKey` already takes for a deleted work item.
- **Reporting-offline** says the record is incomplete, not that the run produced nothing.

### What the surface may PROMISE — quoted, because it is a privacy boundary

> The run modal may state, for any run and without a `--report-log` opt-in, that this run filed these
> bugs and submitted these plans, each as a link to the live row.
>
> — `run-findings-protocol.md` Q5

Both events are LIFECYCLE, so none of this sits behind the log-body opt-in; Q5's privacy section is
explicit that a BYOK-local run sends no additional byte to produce either. **The strip never
summarises** a plan's contents or a bug's body: the record carries a pointer and a title, and a panel
showing more than that would be a design specifying a privacy change.

---

## A DISCREPANCY the run recorded — a fourth row in the findings strip (MOTIR-8656, 2026-10-15)

**AMENDS** § _What the run PRODUCED_ above (and its panel 9 of `run-modal.mock.html`) in the delta
**[`run-modal--discrepancy-finding.mock.html`](./run-modal--discrepancy-finding.mock.html)**, panels
**D1–D7**, each drawn light and dark and, where the layout differs (D2), at 390px. Subtask
MOTIR-8656 of Story MOTIR-8651. **No existing mock is edited**, no image export ships
(`docs/decisions/design-result.md` AMENDMENT 4), and the strip's three existing rows are drawn as
shipped. The component that renders the new row is **MOTIR-8659**; the record it reads is written by
**MOTIR-8655** and reached through **MOTIR-8657**'s `record_run_discrepancy`; the browser proof is
**MOTIR-8663**. The decision is the page _A run builds through a wrong HOW — the discrepancy record_
(MOTIR-8654).

**What a discrepancy IS.** A run built a work item through a plan that was wrong only about the HOW:
the outcome was kept, the route changed, and the run wrote down what the plan asked, what it built and
why. It is a **RECORD of a decision the run made on its own**. It is not a defect (the run delivered),
not an ask (nothing waits on the reader) and not a re-plan. It is closest in kind to the NEWS row — _it
already happened_ — and it must not borrow the bug's hue or the ask's rule, or a build-through would
read as broken work or as something to approve.

### Decisions

1. **Marker and hue — a dot in `--el-info`, no rule, no waiting language.** One existing element token,
   already used as a dot elsewhere in the product. It reads as _informational_. **`--el-type-bug` is
   ruled out** (red says _defect_, and a delivered build-through is not one) and
   **`--el-status-planning` is ruled out** (it is the ask's accent and the `replanned` tone: it would
   say _a person must decide_). The dot is a graphic and needs 3:1; the label stays on `--el-text`.
   **The tone table above gains no row** — this is a finding marker, not a run disposition.
2. **Label and count — _Built differently_, then the leg's key, then _N points_.** The label names
   the act in the product's noun and is the same on every row. **Only the count** is shown: the points'
   text lives in the work item's comment, and the strip shows nothing `data` does not hold
   (`run-findings-protocol.md` Q5). A row that quoted a point would be a design that changed what the
   record carries.
3. **Which work item — always named, mono.** The key is resolved from the event's leg
   (`event.cardId` → `run.cards[].key`) and shown even on a one-leg run, so a row reads the same
   everywhere. `RunFindings` today receives only `events`; **the build passes it the run's legs**.
4. **Order — the ask, then what already happened, then bugs.** Nothing that ships moves: the ask keeps
   the top (the one row that waits on a person), the approved-plans block keeps its place, bugs keep
   the bottom. The discrepancy rows join the _already happened_ group, **after the approved-plans
   block and before the bugs**, separate rows in the run's own `seq` order — never _"3 discrepancies"_,
   which loses which three (D3). A build-through that turned into a stop shows **both** rows on the
   same leg, neither replacing the other (D4).
5. **The door — `Open →` to `/items/<key>`.** The comment is addressed by `data.commentId`, **but the
   item page cannot address a single comment**: read at `origin/main` 911e777,
   `app/(authed)/items/[key]/_components/CommentRow.tsx` and `CommentsSection.tsx` render rows with no
   `id` attribute, and nothing on the page reads a hash or a query to scroll to one. So the door lands
   on the work item, whose Activity section lists the comment. **Landing on the comment is not yet
   possible**; adding an anchor (`id` on the row + a hash read) is a separate change to the item
   page, owned by whoever picks up that follow-up — **the build must not invent an address**, and
   `commentId` stays in the data for the day it can be used. The door's verb is the strip's shared
   `Open →` (`runs.findings.open`, shipped).
6. **The node marker — nothing is drawn, no count is added.** Panel 9 drew a count on the canvas node
   as _an index into the strip_, but **no count ships**: `components/planning/WorkItemNode.tsx`'s
   `RunLegBadge` carries `{ tone, label }` and nothing else, so there is no node marker for bugs or
   plans either. When one ships, **a discrepancy is one more finding in it** (the default: the node is
   an index into the strip), and that build owns the decision. D7 states this and draws nothing.

### Every state

| panel | state                                           | what is drawn                                                              |
| ----- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| D1    | one discrepancy, one point, alone               | the strip appears, holding one row — _1 point_, singular                   |
| D2    | three points, beside a submitted plan and a bug | the order of decision 4, each row with its own door; also at 390px         |
| D3    | a parent run, two legs                          | two rows, each naming its own key                                          |
| D4    | a build-through that became a stop              | the ask on top, the discrepancy under it, same key                         |
| D5    | the leg's work item is gone                     | the row from the run's own data, secondary ink, **no door**, never dropped |
| D6    | `pointCount` missing or not a number            | the label and key, no count — never _0 points_                             |
| D7    | the node marker                                 | nothing: no count ships (decision 6)                                       |

**Not redrawn:** the run with no findings (the strip is absent, unchanged — panel 9) and
reporting-offline (unchanged, panel 9's own).

### Fields read

| rendered element | field(s) read                                                                                   | panel  |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------ |
| whether it shows | the event's `kind` is `discrepancy_recorded`                                                    | all    |
| the run's order  | `DispatchRunEventDto.seq`                                                                       | D2, D3 |
| the work item    | `DispatchRunEventDto.cardId` → `DispatchRunDto.cards[].key` (survives the work item's deletion) | all    |
| the count        | `data.pointCount` — a number, else the label alone                                              | D1, D6 |
| the door         | the same key → `/items/<key>`; `data.commentId` is read but not yet addressable (decision 5)    | D1–D4  |
| no door          | the work item is not visible to this reader (the bug row's rule)                                | D5     |

`data.dispatchRunCardId` is the record's own identity (one per leg) and is not displayed.

### Tone and tokens

| element            | token                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| the dot            | `--el-info`, `--radius-pill` (the strip's `.findKind`)                        |
| label              | `--el-text`, weight 600                                                       |
| the key, the count | `--el-text` (mono for the key)                                                |
| a gone row         | `--el-text-secondary`                                                         |
| the door           | `--el-accent-on-surface`, weight 600 (the strip's `.findGo`)                  |
| row and strip      | `--el-surface-soft`, `--el-border-soft`, `--spacing-card-padding` — unchanged |

### Copy — `en` + `zh`

Under **`runs.findings.*`**, beside the shipped keys; `open` is reused unchanged.

| key                 | en                                              | zh                                |
| ------------------- | ----------------------------------------------- | --------------------------------- |
| `discrepancy`       | Built differently                               | 构建方式与计划不同                |
| `discrepancyPoints` | {count, plural, one {# point} other {# points}} | {count, plural, other {# 项差异}} |
| `open` (reused)     | Open →                                          | 打开 →                            |

The row reads _Built differently · KEY — N points_. Neither string says _card_.

### GIVES / TAKES

| key        | GIVES / TAKES                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-8659 | **GIVES** every panel above, the order, the copy and the tokens — it builds the row. **TAKES** the run's legs into `RunFindings` (for the key) and builds to `/items/<key>`, not to a comment address                                 |
| MOTIR-8655 | **GIVES** nothing drawn. **TAKES** that `data` is exactly `{ commentId, pointCount, dispatchRunCardId }`, as shipped                                                                                                                  |
| MOTIR-8663 | **GIVES** the copy to assert (_Built differently_, _3 points_) and the door's landing: the work item page. **TAKES** nothing — its criterion _the door opens the comment_ is amended to _opens the work item whose Activity lists it_ |
| MOTIR-3893 | **GIVES** nothing, **TAKES** nothing — named only in two stylesheet comments carried verbatim from `run-modal.mock.html` (the run modal's rules)                                                                                      |
| MOTIR-3982 | **GIVES** nothing, **TAKES** nothing — named only in the stylesheet comment above the strip's rules, carried verbatim; the strip it designed is the one this row extends                                                              |
| MOTIR-8656 | this design's own work item, named in the sheet's header comment                                                                                                                                                                      |
| MOTIR-8651 | **GIVES** nothing. **TAKES** nothing. Fixture keys in the mock (MOTIR-1791, MOTIR-1793, MOTIR-1795, MOTIR-1802) are **fixtures**, not work items this design depends on                                                               |

---

## A container's OWN runs — the door on its page, and `/runs?scope=<KEY>`

`run-scope.mock.html` · MOTIR-5402 (design) · gates MOTIR-5363. Measured on `origin/main`
`f5a24c941`; nothing under `design/runs/`, `app/(authed)/runs/` or the run section changed since
the card's base `1491d2af0` (`git log 1491d2af0..origin/main -- …` returned nothing).

### Why a story that was run says it never was

A scoped run (`motir run <story>`) records its CHILDREN as legs; the container has no leg of its
own. The Run section reads legs — `listRunsForWorkItemKey` → `listByWorkItem` — so on a story that
was run it renders _No runs yet_ (panel 0). The read that answers correctly already ships:
`dispatchRunService.listRunsForProject` with `scopeWorkItemKey` → `dispatchRunRepository.listByScope`,
indexed `@@index([scopeWorkItemId, startedAt])`, routed as `GET /api/projects/[key]/dispatch-runs?scope=`.
Before this asset nothing sent it: `RunsIndex.tsx` fetches with `status` and `cursor` only.

### The DOOR — a scope block inside the Run section (panels 1–3)

| the work item has                         | the section shows                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| been a run's scope, never a leg (panel 1) | **no empty state**; the header pill is the latest scoped run's; a _Run as a scope_ block: one line, one row, the door |
| legs AND a scoped run (panel 2)           | the leg content first, unchanged, its pill in the header; the scope block below the section's soft divider            |
| neither (panel 3)                         | `run-section.mock.html` panel 8, byte for byte                                                                        |

**The copy.** Sub-heading _Run as a scope_. Line, live: _An agent is working this work item's
children as one run._ — finished: _An agent worked this work item's children as one run._ Door:
_See every run of `<KEY>` →_. The row is the section's recent-runs row: pill · `<command> ·
<agent> · <model> · <leg summary>` · duration · when. Keyed on _work item_, never on a kind noun,
so one string serves a story, a task and a bug.

**The reads each piece needs — and the one it deliberately does not show.**

| shown                              | read                                                                                               | new?                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------- |
| whether the block renders at all   | `listRunsForProject(projectKey, { take: 1, scopeWorkItemKey: <key> })` — one row or none           | no — the shipped read |
| the row, the leg summary, the pill | the same row (`DispatchRunListItemDto`: command, agent, model, status, startedAt, legs, cardCount) | no                    |
| _is working_ vs _worked_           | the same row's status, through `RUN_IS_LIVE` (`lib/runs/timeline.ts`)                              | no                    |
| **a count of scoped runs**         | **not shown** — no count read exists, and a number here would be one                               | —                     |

**Made only for a work item that HAS CHILDREN**, beside the leg read in `lateReads`. A leaf cannot be
a scope: the CLI sends `scopeKey` only on its scope path, which claims a container
(`packages/cli/src/commands/dispatch.ts`, `command: 'run_scope'`, `decision.target.kind ===
'work_item'`), and a leaf run takes the leaf path with no scope. So the extra query never runs on the
item page's commonest case.

**Static at page load; no stream.** The section's connection rule (_opens no stream unless THIS work
item has a live run_) is about the LEG and is unchanged. Watching a scoped run live is the modal's
job, one click away.

**In panel 2 the header pill stays the LEG's**, because the section already reads its current run
off the leg history's first row; the scope run carries its own pill on its own row, so neither status
stands for the other.

### The NARROWED INDEX — `/runs?scope=<KEY>` (panels 4, 6–9)

The same page, narrowed by the QUERY: both sections, the same row, the same paging and poll.

- **Header.** Title unchanged. Above it, the page's own `.crumb` back link: _All runs_ → `/runs`.
  Subtitle: _Runs of `<KEY>` · `<title>`_, the key linking to `/items/<KEY>`.
- **The Scope column is dropped** under the narrowing — every row would repeat the header.
- **Every client fetch carries `scope=`**: the live poll, the past re-read when a run settles, and
  _Show more_. A poll that dropped it would refill the page with the whole project.
- **⚠️ The header needs a read the page does not make today.** `listRunsForProject` resolves the scope
  row inside its transaction and returns only runs. The subtitle's title and the archived pill need
  that row's key, title and `archivedAt` — returned beside the runs, or read separately. Either way it
  is a read shape MOTIR-5363 owns, and it is the only new read this design calls for.

| face (narrowed)         | panel | what it shows                                                                                                                                                                                                                                                           |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| never run as a scope    | 6     | the index's empty grammar — bot glyph · _`<KEY>` has not been run as a scope yet._ · _Run the whole work item with `motir run <KEY>`. A run that worked one of its children on its own shows on that child's page._                                                     |
| key resolves to nothing | 7     | search-x on the **info** ground, no command, no retry · _No work item `<KEY>` in this project._ · _It may have been deleted, or you may not have access to it. Runs of a deleted work item stay under All runs, listed by their label._ The subtitle key is plain text. |
| archived scope          | 8     | runs listed normally; the subtitle carries an outlined **work-item** pill, _Archived_ — never a run tone. `workItemRepository.findByIdentifier` has no archive filter, so it resolves.                                                                                  |
| loading                 | 9     | runs-index panel 5's skeleton at the narrowed column set; an in-page `<Suspense>`, never a `loading.tsx`                                                                                                                                                                |
| failed read             | 9     | runs-index panel 5's alert + _Try again_; the retry re-reads the narrowed address                                                                                                                                                                                       |

**Three faces, three glyphs — empty is not unresolvable is not failed.** The route answers 404 for an
unresolvable key so that _has no runs_ and _is not yours_ stay different facts; the page keeps them
different too. The copy cannot say _deleted_ or _no access_, because the route deliberately does not.

**A deleted scope is unresolvable, and its runs are not lost.** `scope` is `onDelete: SetNull`, so a
deleted work item's runs lose their scope id and cannot be narrowed to — they stay on `/runs` under
their stored `scopeLabel` (runs-index panel 4). Panel 7's copy points there.

### The ADDRESS CONTRACT (panel 5)

| from                    | action                     | address                      | how                                                     |
| ----------------------- | -------------------------- | ---------------------------- | ------------------------------------------------------- |
| item page · Run section | the door, or the scope row | `/runs?scope=<KEY>`          | a link — a route change; the server reads both sections |
| narrowed index          | open a run                 | `/runs?scope=<KEY>&run=<id>` | `shallowPush` — keeps a history entry                   |
| run modal               | close · `ESC` · Back       | `/runs?scope=<KEY>`          | `shallowPush` (Back pops the entry)                     |
| narrowed index          | _All runs_                 | `/runs`                      | a link — a different server read                        |
| narrowed index          | the subtitle key           | `/items/<KEY>`               | a link                                                  |

- **The parameter is `scope`, and it takes a work-item KEY.** The service upper-cases it, so a
  lower-case key resolves; every link the product writes uses the upper-case key.
- **`run` composes with `scope`; neither replaces the other.** `RunsIndex` today writes
  `/runs?run=<id>` and `/runs` literally on open and close, which would drop the narrowing on the
  first click — the build adds and removes `run` while keeping every other parameter.
- **The navigation primitive follows `CLAUDE.md`'s discriminator.** Entering or leaving a scope
  changes both server reads the page makes, so it is a real navigation. Opening or closing a run is
  not: the modal fetches its run client-side (the `?run=` rule above, unchanged).
- A `run` that is not a run of that scope still opens: the modal reads by id and does not check the
  list behind it.

### What `?scope=` can never address (panel 10)

`scopeWorkItemId` is set in exactly one place — the scope path of `motir run`, when it claims a
CONTAINER. So a sprint run (`scopeLabel` only, _the active sprint_), every leaf / `next` / `batch` /
`auto` run (legs only) and a run whose scope was since deleted (scope set to null) are never
addressable by `?scope=`. None is missing: each is on `/runs`, and every leg is on its own work item's
Run section.

### GIVES / TAKES — the build card this design gates

`grep -o 'MOTIR-[0-9]*' run-scope.mock.html | sort -u` names MOTIR-1511, MOTIR-1789, MOTIR-1795,
MOTIR-2044, MOTIR-2210, MOTIR-3412, MOTIR-5363, MOTIR-5402 and MOTIR-9999. MOTIR-1795 is the header
comment's citation of the area's owner; MOTIR-5363 and MOTIR-5402 are this design and its build.
The rest are **fixture keys** in drawn rows, not references to those work items.

- **MOTIR-5363 — GIVES**, and its criteria are amended on the record in the same pass: the scope
  block and its `take: 1` read in `lateReads` (children only) · the narrowed header, **including the
  one new read** (the scope row's key, title and archived flag) · the dropped Scope column · the
  empty, unresolvable and archived faces · `scope=` on every fetch · `?scope=` + `?run=` composition
  on open and close · the new `runs` strings in `en` and `zh`. **TAKES nothing.**
- **MOTIR-5398** — neither: it moves the section's links onto `?run=`; this design only adds
  `scope` alongside.
- **MOTIR-1796 · MOTIR-3923** — `done`; their surfaces are extended, not reopened.

---

## At scale — two different growth curves, two different answers

| surface       | what grows                                                     | drawn against | the decision                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/runs`       | **unbounded, forever** — run headers are append-only           | **25 a page** | **PAGE.** Cursor, not offset, so a run opened mid-read cannot shift a row across the boundary                                                                                                                          |
| the run MODAL | bounded by the SCOPE — a sprint run claims tens, not thousands | **40 nodes**  | **The canvas's own** — it pans, zooms and drills, and `design/roadmap/` already decided how it behaves past a screenful. This asset adds no second scale rule; what it owes is the stored ORDER the level is served in |

**The index grows and never shrinks**, because the retention sweep clears event BODIES after 30 days
and removes no rows: a project running `motir auto` nightly accumulates a run per night for as long
as it lives. A load-everything read there is not a shortcut, it is a page that gets slower every day.
**Paging rather than virtualization** because the live section is short by construction and the past
section is what grows, so there is one growing list with a natural stopping point — a reader looking
for last week's run pages, they do not scroll. The order is `startedAt DESC, id DESC`, **total**
because the id breaks the tie.

**The run view's set is bounded by its scope** and a reader wants the whole ordered list rather than
a scrolling window, so it pages past 40 and never virtualizes. Neither surface issues an unbounded
read: the set is fetched with the run, and the events stream separately.

---

## THE TONE VOCABULARY

**Defined once, here, and consumed by every run surface in the product.** The run view
(MOTIR-3893) reads this table rather than writing a second one — a design area with two authors and
no owner ends up with two status vocabularies for the same states, which is how one product acquires
two visual languages for _failed_.

**The shape of every tone is the same**: a tinted background carrying `--el-text-strong`, with the
hue in a **7px dot** rather than in the ink. That is the AA-safe pairing `CLAUDE.md`'s measured table
requires (a coloured chip puts the hue in the tint BACKGROUND, never in the text), and it means a
status is legible in a compact chip and in a table row without a second treatment.

| Status                | Background           | Dot                       | Why this tone                                                                                           |
| --------------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **queued**            | `--el-muted`         | `--el-status-todo`        | Owned by a run, not started. Neutral because nothing has happened yet.                                  |
| **running**           | `--el-tint-sky`      | `--el-status-in-progress` | The product's existing In-Progress hue, so a run in flight reads like work in flight.                   |
| **integrated**        | `--el-tint-mint`     | `--el-status-done`        | On a session branch. Success tone; the delivery section says whether it merged.                         |
| **implemented**       | `--el-tint-mint`     | `--el-status-done`        | Its own pull request is open. Shares integrated's tone: to a reader both mean _the agent finished_.     |
| **failed**            | `--el-tint-rose`     | `--el-danger`             | **The only danger tone in the set.** Reserve it — everything else here is a legitimate ending.          |
| **re-planned**        | `--el-tint-lavender` | `--el-status-planning`    | The Planning hue. Neither green nor red, which is the entire point of the row.                          |
| **skipped**           | `--el-muted`         | `--el-text-tertiary`      | A decision the run made. **Always shown WITH its reason**; a bare "skipped" says nothing.               |
| **cancelled**         | `--el-muted`         | `--el-status-cancelled`   | Somebody pressed Ctrl-C. A decision, not a fault.                                                       |
| **timed out**         | `--el-tint-peach`    | `--el-warning`            | Written by the server's reap, never by a client. Warning rather than danger: _unknown_ is not _failed_. |
| **reporting-offline** | `--el-tint-peach`    | `--el-text-tertiary`      | The RECORD is incomplete, not the run. Warning ground, NEUTRAL dot — deliberately not danger.           |

**Ten statuses, five backgrounds, and the collisions are deliberate.** `integrated` / `implemented`
are one outcome to a reader; `queued` / `skipped` / `cancelled` are all "nothing ran", told apart by
their dot and their label rather than by a sixth tint nobody could name. Inventing five more hues
would make the palette carry a distinction the reader does not need and the token layer cannot swap
coherently.

**Two rules the table encodes, and both are refusals:**

- **Never invent a hue.** Every dot above is an existing `--el-*` token. A run state is not a reason
  to add a colour.
- **Never signal a run state with a border style.** No dashed, dotted or doubled border anywhere in
  this area. A border style is not a state signal — it is invisible at a glance, it collides with
  the dashed rings and outlines the product already uses for other meanings, and it survives no
  palette.

### The two states that get improvised if nobody draws them

- **RE-PLANNED.** The agent read the work item, found its premise false, reverted, submitted a plan and
  exited **0**. It is neither a success nor a failure and will be drawn as one of them by whichever
  work item passes through it first. Its body says what to do next, because a state whose entire content
  is _somebody must look at this_ is useless without the link.
- **REPORTING-OFFLINE.** The run happened; the record did not. Reporting is best-effort by design —
  a 500, an expired token or a dead network must never break a run — so what reaches Motir is a run
  that opened and then went quiet. **It must not read as a failed run**: the work may have shipped
  perfectly. A hosted run can never be in this state, which is exactly why it is the one most likely
  to be missed.

---

## Every state, and where it is drawn

| State                              | `run-section.mock.html` | Note                                                                                                                      |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| empty — "nothing has run"          | panel 8                 | **Must not read as an error**: muted glyph, one sentence of fact, the command that changes it.                            |
| running                            | panel 1                 | The live timeline, one row per card-scoped event, with the "one of N" line when the run covers a set.                     |
| succeeded (implemented)            | panel 2                 | The terminal disposition, and the log console is deliberately absent.                                                     |
| failed                             | panel 4                 | The body says the work item stays In Progress and nothing was reverted.                                                   |
| re-planned                         | panel 3                 | Links to the plan.                                                                                                        |
| cancelled                          | panel 5                 | Neutral tone: a decision, not a fault.                                                                                    |
| timed out                          | panel 5                 | Warning tone. The copy says what is unknown, not what failed.                                                             |
| **reporting-offline**              | panel 6                 | The notice names which of the two facts is missing and points at Development for what shipped.                            |
| stream-reconnecting                | panel 7                 | **A transport state, not a run state**: the notice sits above the timeline and the run's own pill keeps saying _Running_. |
| **skipped — this work item's leg** | panel 9                 | A run owned this work item and decided not to work it. **A skipped row is a real row**, always carrying its reason.       |
| queued (in a run)                  | panel 12 (tone)         | Only meaningful where a run owns a work item it has not reached.                                                          |

**The two PAGES have their own states, and the overlap is smaller than it looks** — the section is a
panel about ONE work item, so most of its states are about that work item's leg; a page is about a RUN, so most
of its states are about the run and the list.

| State                              | `runs-index.mock.html` | `run-modal.mock.html` | Note                                                                                             |
| ---------------------------------- | ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| nothing has run at all             | panel 3                | —                     | Muted glyph, one sentence, the command that changes it. **Never an error face.**                 |
| one side of the partition empty    | panel 2                | —                     | The live section states the fact and keeps its shape rather than disappearing.                   |
| a live run                         | panel 1                | panel 1               | The index shows one row; the view shows the whole set around it.                                 |
| a run with NO work items           | panel 4                | panel 6               | A real outcome, in the neutral tone — never an error.                                            |
| a run whose SCOPE item was deleted | panel 4                | —                     | The row survives it: the record stores the scope LABEL beside the id.                            |
| a LEG whose work item was deleted  | —                      | panel 8               | The leg keeps its key, disposition and duration; only the link is absent.                        |
| loading                            | panel 5                | —                     | An in-page `<Suspense>`, **never a `loading.tsx`** — see the index section above.                |
| a failed read                      | panel 5                | —                     | Says what failed and offers the retry; must not share a face with the empty state.               |
| queued — claimed, nothing started  | —                      | panel 6               | The moment a person is most likely to press Ctrl-C, so it must be readable at t=0.               |
| finished, once per stop reason     | —                      | panel 7               | `halted` and `drained` are opposite news. **`replanned` is a SUCCESS** — the agent was right.    |
| interrupted                        | —                      | panel 7               | Cancelled tone: a decision, not a fault.                                                         |
| timed out                          | —                      | panel 7               | Written by the server's reap, never by a client. Warning, not danger: _unknown_ is not _failed_. |
| **reporting-offline**              | —                      | panel 8               | The record is incomplete, not the run. Points at each work item's Development section.           |
| stream-reconnecting                | —                      | panel 8               | A TRANSPORT state: the notice sits above the table and the run's pill keeps saying _Running_.    |
| at scale                           | panel 6                | panel 9               | 25 rows a page · 40 rows before the set pages. See _At scale_ above.                             |
| **produced NEITHER** — the default | —                      | panel 9               | **No region at all.** The log pane starts at the log. Drawn first, because it is most runs.      |
| a plan SUBMITTED, waiting          | —                      | panel 10              | An ASK: the accent rule and the strip's only action. `replanned` tone — a success, not a fault.  |
| plans APPROVED by this run         | —                      | panel 10              | NEWS, named plan by plan. **Never a count** — `autoLoop.ts` settled that and the surface obeys.  |
| a bug FILED — one, or several      | —                      | panel 11              | Separate rows always, each with `Open →`. Additive ≠ unreachable: nothing moved, but you can go. |
| a bug since CLOSED or ARCHIVED     | —                      | panel 11              | Still renders, with the WORK ITEM's own status pill — not a run tone.                            |
| a plan since DECLINED              | —                      | panel 12              | The run's wording is kept and the plan's current status rides beside it. Never hidden.           |
| a finding whose TARGET is gone     | —                      | panel 12              | Drawn from the event's `data` alone, unlinked. **Never dropped, never an empty state.**          |
| reporting-offline, with findings   | —                      | panel 12              | The only state where the strip appears carrying none: incomplete ≠ produced nothing.             |

**A container's own runs** — `run-scope.mock.html`, whose states belong to neither table above: three
are the Run SECTION's on a container, and the rest are the INDEX's under a narrowing.

| State                              | `run-scope.mock.html` | Note                                                                                                    |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| the false empty state, as it ships | panel 0               | A story that was run reads _No runs yet_ — the defect, drawn so the fix has a before.                   |
| run as a scope, never as a leg     | panel 1               | The scope block replaces the empty state; the header pill is the latest scoped run's. No step timeline. |
| a leg AND a scoped run             | panel 2               | Leg content first and unchanged; the scope block below the soft divider.                                |
| never run either way               | panel 3               | `run-section.mock.html` panel 8, unchanged.                                                             |
| the narrowed index                 | panel 4               | Both sections, no Scope column, _All runs_ back link, the key linking to the work item.                 |
| the address contract               | panel 5               | `scope` survives opening and closing a run.                                                             |
| never run as a scope (narrowed)    | panel 6               | The index's empty grammar — **never an error face**.                                                    |
| a key that resolves to nothing     | panel 7               | Info ground, search-x, no command, no retry — **distinct from empty and from failed**.                  |
| an archived scope                  | panel 8               | Resolves; outlined work-item pill in the subtitle.                                                      |
| loading · a failed read (narrowed) | panel 9               | runs-index panel 5 at the narrowed column set; the retry keeps `scope`.                                 |
| runs `?scope=` can never address   | panel 10              | Sprint, leaf / `next` / `batch` / `auto`, a deleted scope — each with where it is instead.              |

---

## The log console

Present **only** when the run was started with `--report-log`
(`docs/decisions/dispatch-run-record.md` Q4). Drawn in `run-section.mock.html` panel 10, in both
faces:

- **Collapsed by default, never an always-expanded wall of text.** The item page is where a person
  reads the CARD; a live log is the loudest thing on any page it appears on.
- **Open, it follows the tail** inside a capped scroll region (`max-height: 190px`), and the
  _following_ chip is a state rather than a control.
- **Closed and empty is the ORDINARY case**, and it states the promise — _"Your agent's output
  stayed on your machine"_ — rather than showing a blank box, because a blank box reads as a failure
  to record.
- The footer states the **30-day** retention, because that is the half of the promise the flag makes.

**The opt-in control is not on this surface, and that is where the decision put it.** `--report-log`
is a CLI flag (and a `reportLogBodies` config key); there is deliberately no server-side setting,
because the machine that holds the content is the machine that decides whether it leaves. The
surfaces therefore STATE the boundary and never offer to change it — a workspace admin flipping a
switch that exfiltrates somebody else's laptop is the exact shape the decision refuses.

---

## Primitives and tokens

**Primitives composed** (nothing hand-rolled that a primitive owns):

| Primitive                              | Used for                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `ContentSectionCard` + `Card`          | the section's chrome, header row and body padding — the late stack's own grammar |
| `Pill`                                 | every run-status chip                                                            |
| `Button` (ghost, `sm`)                 | "Show more" on the recent-runs list                                              |
| the shipped `TableShell` / `Th` / `Td` | both pages' tables — the jobs dashboard's grammar, composed rather than rebuilt  |
| the shipped `Sidebar` row              | the rail entry in the index's access-path panel                                  |

**Shape tokens** — every surface's own box, nothing raw:

| Element                      | Tokens                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| the section card             | `--radius-card` · `--spacing-card-padding` · `--shadow-card`             |
| every run-status pill        | `--radius-badge` · `--spacing-chip-x` / `--spacing-chip-y`               |
| the log console              | `--radius-control` · `--spacing-control-x` / `--spacing-control-y`       |
| a table cell (both pages)    | `--spacing-control-x` / `--spacing-control-y`, on `--radius-card` chrome |
| a rail row                   | `--radius-control` · `--spacing-control-x` / `--spacing-control-y`       |
| the "Show more" button       | `--radius-btn` · `--height-btn-sm` · `--spacing-btn-x-sm`                |
| the timeline / list dividers | `--el-border-soft`                                                       |

**Ink**: body text is `--el-text`; every secondary line is **`--el-text-secondary`**, which clears AA
on all four surfaces in both themes. `--el-text-muted` is used **nowhere** in this area — it fails AA
on `--el-surface`, `--el-surface-soft` and `--el-muted`, and both the section body and the console
head sit on `--el-surface-soft`. `--el-text-faint` is used nowhere at all.

---

## Where each behaviour came from

| Behaviour drawn here                                                            | Decided by                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| the CARD-SCOPED event vocabulary the timeline renders                           | `docs/decisions/dispatch-run-record.md` **Q2** (MOTIR-1790)                                                          |
| the disposition vocabulary the tone table covers                                | the same decision's `DispatchCardDisposition` and `DispatchStopReason`                                               |
| a run covers a SET, so a work item can be "4 of 11"                             | the same decision's **Q1**                                                                                           |
| the pull request and CI are NOT the run's                                       | the same decision's **Q3**, boundary 1                                                                               |
| the log console, its opt-in, and the 30-day retention                           | the same decision's **Q4**                                                                                           |
| reporting is best-effort, hence _reporting-offline_ as a first-class state      | MOTIR-1794 (the CLI reporter) — the emissions this visualises                                                        |
| ordering by `seq`, hence a resumable stream and the reconnecting notice         | MOTIR-1791 (`@@unique([dispatchRunId, seq])`) and MOTIR-1793 (the `?since=` cursor)                                  |
| SSE rather than a WebSocket, and the terminal `done` frame that closes it       | MOTIR-1793's stream route, which mirrors the shipped plan-generation stream                                          |
| the three SET shapes, and that a single work item is the degenerate case of one | `packages/cli/src/scopedRun.ts` (`renderClaimedScope`) and `packages/cli/src/batchPlan.ts` (`Snapshot`)              |
| every stop reason and its sentence                                              | `packages/cli/src/autoLoop.ts` + `packages/cli/src/batchPlan.ts` (`STOP_LABEL`)                                      |
| the six skip reasons and their sentences                                        | `packages/cli/src/batchPlan.ts` (`SKIP_LABEL`)                                                                       |
| the In-Progress-from-t=0 warning, in the words the terminal prints              | `packages/cli/src/scopedRun.ts`                                                                                      |
| the rail convention every top-level view follows                                | `app/(authed)/_components/SidebarNav.tsx` + `design/shell/design-notes.md`                                           |
| the nav row's registration, and that omitting it hides the page silently        | `lib/settings/projectNavAccess.ts` and its own header                                                                |
| the table grammar the two pages compose                                         | `app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx` (`TableShell` / `Th` / `Td`)                    |
| the run history is "every run that carried a leg for this work item"            | MOTIR-1793's read                                                                                                    |
| the late stack's ONE settle                                                     | `design/work-items/design-notes.md` § _The item page at ARRIVAL_ (MOTIR-3432, amended by MOTIR-3465)                 |
| a container's own runs are its SCOPED runs, a different question from its legs  | `listRunsForProject` + `scopeWorkItemKey` → `listByScope` (MOTIR-3922); decided surface-not-drop on MOTIR-5363       |
| only a container is ever a scope, and a sprint run has no scope work item       | `packages/cli/src/commands/dispatch.ts` (the `run_scope` path) + `lib/services/dispatchRunService.ts` (the run open) |
| an unresolvable scope key is a 404, not an empty list                           | `app/api/projects/[key]/dispatch-runs/route.ts` + `listRunsForProject`'s own comment                                 |
| an archived scope still resolves                                                | `workItemRepository.findByIdentifier` — no archive filter                                                            |
| a deleted scope's runs lose the scope id and keep their label                   | `prisma/schema.prisma` — `DispatchRun.scope` `onDelete: SetNull`, beside `scopeLabel`                                |
| a link to enter or leave a scope, `shallowPush` to open or close a run          | `CLAUDE.md` § _URL state the CLIENT reads is written with `shallowPush`_                                             |

---

## Out of scope — a deliberate later AMENDMENT, not a second surface

**MOTIR-691 (9.1.1) amends THESE surfaces; it does not draw new ones.** The hosted mode adds:

- a **"Run hosted"** kick-off control,
- an **agent selector**,
- a **cancel** control,
- and a **token-usage / credit-cost** block.

None of them is drawn here, and the cost block in particular is not a gap: **a BYOK run has no
credit cost**, because it never touches the gateway. Room is left for the first three in the
section's header (`.secRight` currently carries only the status pill) and for the cost block below
the meta row.

Also out of scope: **the design-approval gate** (MOTIR-693 / 9.2) and **cross-project run rollups**
(Epic 10 / MOTIR-732), both of which have their own homes.

---

## Run died — the work item says its run died, and hands over `motir continue` (MOTIR-6529, 2026-09-27)

**AMENDS** this area's `run-section.mock.html` (_Every state_, panel 6 — the `timed_out` CloudOff
_reporting offline_ note) and `design/github/design-notes.md` **§ 21** (the Development block's fix
part, whose grammar this reuses) — in the delta
**[`run-section--run-died.mock.html`](./run-section--run-died.mock.html)**, Panels **D1–D8** and
**R1**, each at desktop, dark and ~400px where its layout differs. Card MOTIR-6529. **No existing mock
is edited** and no image export ships (`docs/decisions/design-result.md` AMENDMENT 4). The code that
renders every panel is **MOTIR-6534**; the view it reads is **MOTIR-6532**'s `getContinueView`; the
rule it applies is **MOTIR-6528**'s `isRunAlive` (`lib/runs/runLiveness.ts`). The direction is
`docs/decisions/run-death-keeps-work.md`.

**Why it is owed.** A run that dies — the laptop sleeps for good, the terminal is closed — leaves its
work item In Progress with nothing on the page saying so; at best a `timed_out` run shows _"This run
stopped reporting"_, which suggests waiting. A person opening the item needs three answers at once:
**is the work lost, who was doing it, and what do I do now.**

**Access path.** The item page, and nothing else. The **run section** says the run died (Panel R1);
the **Development card** carries the new **continue part** (Panels D1–D8) — a sibling of § 21's fix
part, in the same place: below the rows' caption (or, with no pull request, below the EmptyState)
and above How to test. No new entry point and no new navigation.

### Rendered against shipped reality, not redrawn

The Development card, its rows, caption, EmptyState, the part grammar, the command block and How to
test are § 21's sheet — itself `DevelopmentSectionBody` rendered at `origin/main` `3205ae235` — and
the delta's stylesheet and sprite sheet are `github--fix-callout.mock.html`'s, verbatim
(`audit-mock-sprites --strict`: 44 symbols, 0 drifted, 0 undeclared; no new sprite). The run
section's pills, step list and history row are `RunSection.tsx` at `origin/main` `874665544`, read
line by line; its died line takes the CloudOff note's markup and place.

### The panels

| panel | state                                                                                                                                                        | shown when (the continue view, MOTIR-6532)                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| D1    | **Died** — the reason line, who ran it and with which command, the branch, _the work item is still In Progress_, `motir continue <KEY>`, the start-over hint | `died`: the last run is not alive by `isRunAlive`, it did not succeed, it left a pushed branch, and nobody holds it  |
| D2    | **Died, with a draft pull request** — the branch line names the session branch AND the draft, as the row's meta line names it                                | `died`, and a draft pull request is linked (a parent run's)                                                          |
| D3    | **The reason line**, one per ending — lapsed · interrupted · failed · cancelled · stalled (hosted) · the 12-hour backstop (hosted)                           | the dead run's `stopReason` / `status`; a hosted `timed_out` is split by its closing `log` line                      |
| D4    | **Died, nothing pushed** — no command; the start-over hint is the only move                                                                                  | `died` with no pushed branch (the claim would refuse `nothing_pushed`)                                               |
| D5    | **Continuing** — who, since when, whose run they took over, the branch and a link to the run; **no command**                                                 | an open `continue` run holds the item (`taken`; `mine` for the viewer → _Being continued by **you**_, Panel D5b)     |
| D6    | **Implemented with a died run** — the pull request is open, CI decides, `motir fix` if it goes red; **no continue**                                          | the item is `implemented` (the claim refuses `implemented`)                                                          |
| D7    | **A child of a parent run** — points at the parent and carries the PARENT's command, `motir continue <PARENT>`                                               | the dead run was a scoped parent run (`continue_on_run_target`, naming the run-target key)                           |
| D8    | **Loading** (two skeleton bars, labelled) · **Error** (what failed + _Try again_)                                                                            | the view's read is pending / failed                                                                                  |
| R1    | **The run section** — the died line replaces _reporting offline_; the RUN pill reads **Run died** even while the row still says `running`                    | the section's current run is not alive by `isRunAlive` and did not succeed — **before any sweep has closed its row** |

**Not shown — a note, not a panel.** The part renders nothing, and the page is exactly what ships,
when the last run is **alive** (a local run that heartbeat under 5 minutes ago, an open hosted run, a
legacy run inside its 12 hours), when it **succeeded**, or when the item has **never been run**: the
view's `alive` and `none`. The part and the claim read ONE view; the part never offers a command the
claim would refuse.

### Decisions

| decision                    | chosen                                                                                                | why                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| where the command lives     | the **Development card**, as a flush part beside § 21's fix part — not in the run section             | a red build handed to an agent and a dead run handed to an agent are the same kind of act, and the branch and draft it continues are what Development already shows |
| what the run section does   | **one line**, in the CloudOff note's place, pointing DOWN to the part; the RUN pill says **Run died** | the run section is about the run; repeating the command there would put two copies of one control on one page                                                       |
| the tone                    | the run area's **timed-out** tone for every ending: peach ground, `--el-warning` glyph                | _unknown is not failed_ (the tone vocabulary above). Every death is the same fact to the reader — the work stopped and is kept; the reason line says how            |
| saying the work is safe     | an explicit sentence: _Nothing was lost and nothing moved: this work item is still **In Progress**._  | the one thing this marker must not imply is that the item moved; saying the status in words is cheaper than a reader inferring it from a pill                       |
| continuing shows no command | none, not a disabled one                                                                              | § 21's in-progress rule: a second person must not start a second continue, and the claim would refuse it (`taken`)                                                  |
| nothing pushed              | the start-over hint alone                                                                             | there is no branch to continue on; a command the claim refuses is a trap                                                                                            |
| Implemented                 | a sentence naming the open pull request and `motir fix`; no command of its own                        | CI decides from there (`run-death-keeps-work.md`, _What this does NOT decide_); § 21's fix part renders ABOVE this one when checks go red                           |
| the child of a parent run   | the parent's command, `motir continue <PARENT>`, under § 21's F4 pointer grammar                      | a parent run resumes as a whole on its session branch and draft; the child's own command would be refused                                                           |
| the time                    | relative (`relativeLabel`, § 21's function) on a `<time datetime>`, `formatRunInstant` in `title`     | the same clock and format as the fix part                                                                                                                           |
| the start-over hint         | one quiet line: _Start over instead: set this work item to **To Do** and run it again._               | starting over is a deliberate person's act (`run-death-keeps-work.md` §3); the page names it and does not do it                                                     |

### Fields read

| rendered element           | field(s) read                                                                                                                | panel  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| whether the part renders   | the continue view's `state` (`alive · died · continuing · none`), derived server-side through `isRunAlive`                   | all    |
| the reason line            | the dead run's `status`, `stopReason`, `origin`, and for a hosted `timed_out` its closing `log` event                        | D1–D3  |
| last heard from            | `lastHeardFrom(run)` — its last heartbeat, else its start (`lib/runs/runLiveness.ts`); the run's `endedAt` once it is closed | D1–D7  |
| who ran it and the command | the dead run's `createdBy` display name and `command`                                                                        | D1, D5 |
| the branch                 | the dead run's leg `sessionBranch`, else its `checkout_ready` event's `data.branch` (MOTIR-6530); whether it was pushed      | D1–D4  |
| the draft pull request     | the item's linked open pull request, as the row's meta line names it (`repo · #n`)                                           | D2     |
| the holder and start       | the open `continue` run's `createdBy` and `startedAt`; _you_ when it is the viewer                                           | D5     |
| the run-target key         | the dead run's scope work item's key                                                                                         | D7     |

### Tone and tokens

`--el-*` colour and element-semantic shape tokens only; each `rd-` rule in the delta quotes the class
string MOTIR-6534 builds it from, and every other rule is § 21's. The part: `border-(--el-border-soft)`
rule, `h4` in `--el-text`. The reason line: `--el-text`, its `triangle-alert` glyph `--el-icon-muted`.
The holder / branch / pointer lines: `--el-text-secondary`, names in `--el-text`, the branch in the
mono face. The notes and the start-over hint: `--el-text-secondary`. Pills ride the shipped `Pill`
axes, no new variant: _Run died_ `tone="peach"` (the timed-out tone) + `triangle-alert`; _Continuing_
`status="in-progress"` (sky) + `circle-ellipsis`. The run section's died line glyph is
`--el-warning`, the timed-out dot's token.

### Copy — `en` + `zh`

One namespace, **`github.development.continue`**, beside `github.development.fix`; the run section's
line is **`runs.runDied`**. The code block's _Copy_ strings are `github.development.howToTest.code.*`,
shipped and not re-keyed.

| key                   | en                                                                                                                                        | zh                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `title` / `aria.part` | Continue the work                                                                                                                         | 继续这项工作                                                                                  |
| `died.pill`           | Run died                                                                                                                                  | 运行已中断                                                                                    |
| `reason.lapsed`       | The run stopped reporting — last heard from {time}.                                                                                       | 运行已停止上报——最后一次联系在{time}。                                                        |
| `reason.interrupted`  | The run was stopped from its terminal {time}.                                                                                             | 运行已在其终端中被停止（{time}）。                                                            |
| `reason.failed`       | The agent exited with an error {time}.                                                                                                    | 智能体出错退出（{time}）。                                                                    |
| `reason.cancelled`    | The run was cancelled {time}.                                                                                                             | 运行已被取消（{time}）。                                                                      |
| `reason.stalled`      | The hosted agent stalled — no output for 15 minutes — {time}.                                                                             | 托管智能体停滞——15 分钟无输出（{time}）。                                                     |
| `reason.backstop`     | The hosted run reached its 12-hour limit {time}.                                                                                          | 托管运行已达 12 小时上限（{time}）。                                                          |
| `ranBy`               | Run by {name} with {command} · started {time}                                                                                             | 由 {name} 通过 {command} 运行 · {time}开始                                                    |
| `branch`              | Its work is on {branch}                                                                                                                   | 其工作位于 {branch}                                                                           |
| `branchWithDraft`     | Its work is on {branch} and in the draft pull request {pr}                                                                                | 其工作位于 {branch} 以及草稿拉取请求 {pr} 中                                                  |
| `safe`                | Nothing was lost and nothing moved: this work item is still {status}.                                                                     | 没有丢失任何内容，也没有任何变动：此工作项仍为{status}。                                      |
| `lead`                | Carry it on from your terminal:                                                                                                           | 在终端中继续：                                                                                |
| `how`                 | An agent checks out that branch, reads what is already committed, merges the latest main, and finishes the work item in one pull request. | 智能体会检出该分支，阅读已提交的内容，合并最新的 main，并在一个拉取请求中完成此工作项。       |
| `startOver`           | Start over instead: set {target} to To Do and run it again.                                                                               | 或者重新开始：将 {target} 设为待办并重新运行。                                                |
| `nothingPushed`       | Its branch was never pushed, so there is nothing to continue.                                                                             | 其分支从未推送，因此没有可继续的内容。                                                        |
| `continuing.pill`     | Continuing                                                                                                                                | 继续中                                                                                        |
| `continuing.by`       | Being continued by {name} · started {time}                                                                                                | {name} 正在继续 · {time}开始                                                                  |
| `continuing.byYou`    | Being continued by you · started {time}                                                                                                   | 你正在继续 · {time}开始                                                                       |
| `continuing.tookOver` | It took over from {name}, whose run stopped reporting {time}                                                                              | 接手自 {name}，其运行在{time}停止上报                                                         |
| `continuing.on`       | On {branch} · See the run                                                                                                                 | 位于 {branch} · 查看运行                                                                      |
| `continuing.why`      | Only one continue runs at a time. When it finishes, this work item moves on exactly as after motir run.                                   | 同一时间只运行一个继续。完成后，此工作项会像 motir run 之后一样继续推进。                     |
| `implemented.line`    | The run stopped reporting {time}, after it opened its pull request.                                                                       | 运行在打开拉取请求之后停止上报（{time}）。                                                    |
| `implemented.pr`      | The pull request {pr} is open, so there is nothing to continue: its checks decide from here.                                              | 拉取请求 {pr} 已打开，因此没有可继续的内容：接下来由其检查决定。                              |
| `implemented.fix`     | If they fail, motir fix {key} hands the repair to an agent — the Fix the checks part appears above when they do.                          | 如果检查失败，motir fix {key} 会将修复交给智能体——届时上方会出现“修复检查”。                  |
| `child.line`          | The run that owned this work item stopped reporting {time}.                                                                               | 负责此工作项的运行在{time}停止上报。                                                          |
| `child.pointer`       | It was run as part of {key}, so it is continued from there — the whole run resumes on its branch and skips what already landed:           | 它是作为 {key} 的一部分运行的，因此从那里继续——整个运行会在其分支上恢复，并跳过已完成的部分： |
| `loading`             | Checking whether this work item's run is still alive                                                                                      | 正在检查此工作项的运行是否仍在进行                                                            |
| `error`               | Couldn't check whether this work item's run is still alive.                                                                               | 无法检查此工作项的运行是否仍在进行。                                                          |
| `retry`               | Try again                                                                                                                                 | 重试                                                                                          |
| `runs.runDied`        | This run died — last heard from {time}. Its work is kept on its branch; continue it from Development below.                               | 此运行已中断——最后一次联系在{time}。其工作保留在分支上；请在下方“开发”中继续。                |

`{time}` is `relativeLabel` (_12 min ago_ / _12分钟前_); `{branch}` is set in the mono face; `{pr}` is
the row's `repo · #n`; `{status}` is the workflow status's own label.

### Scope

**Drawn:** the continue part in every state above at desktop, dark and ~400px where its layout
differs; the run section's died line; the not-shown rule. **Not drawn, and whose it is:** the
component and the run-section change — MOTIR-6534; the view and the claim, with every refusal's
name — MOTIR-6532; the liveness rule — MOTIR-6528; `motir continue`'s terminal output — MOTIR-6533
(and MOTIR-6535 for a parent), which needs no design; a browser _Continue hosted_ button — the
browser-continue story MOTIR-6527, with its own design; the acceptance video — MOTIR-6536.

### GIVES / TAKES

| key        | GIVES / TAKES                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-6534 | **GIVES** every panel (D1–D8, R1), the not-shown rule, the copy and the tokens above — it builds the part and the run-section line. **TAKES** nothing it does not already own                                                                                                                                    |
| MOTIR-6532 | **GIVES** each outcome a drawing (`died` D1–D4 · `continuing` / `taken` / `mine` D5 · `implemented` D6 · `continue_on_run_target` D7 · `nothing_pushed` D4). **TAKES** the view's fields above: the dead run's reason, holder, branch and whether it was pushed, the draft, and the open `continue` run's holder |
| MOTIR-6530 | **TAKES** that each leg's branch is recorded (`checkout_ready` `data.branch`, and the leg's `sessionBranch`) so D1's branch line has something to read                                                                                                                                                           |
| MOTIR-6528 | **GIVES** nothing drawn. **TAKES** that `isRunAlive` and `lastHeardFrom` are the ONLY reading of liveness — R1's pill and the part's state both come from it                                                                                                                                                     |
| MOTIR-6536 | **GIVES** the script: R1 + D1 after a kill → D5 after `motir continue` → D6 / refusals in words. **TAKES** nothing                                                                                                                                                                                               |
| MOTIR-6529 | this card                                                                                                                                                                                                                                                                                                        |

Fixture items use `ACME-n` keys: **ACME-14** a leaf, **ACME-12** the story whose parent run it
belonged to.

## Continue hosted — the browser resumes a dead run (MOTIR-6789, 2026-09-28)

**AMENDS** § _Run died_ above (Panels **D1**, **D2**, **D5**, **D7** and **R1** of
`run-section--run-died.mock.html`) and MOTIR-684's approved Run hosted design (the published
`run-section--hosted.mock.html` — the model picker, the door's refusal notices and the hosted run's
phases) — in the delta
**[`development--continue-hosted.mock.html`](./development--continue-hosted.mock.html)**, Panels
**C1–C5** and **C7**, each at desktop, dark and ~400px where its layout differs; **C6** is a note.
Card MOTIR-6789, story MOTIR-6527. **No existing mock is edited** and no image export ships
(`docs/decisions/design-result.md` AMENDMENT 4). The component is **MOTIR-6796**; the start path it
calls is **MOTIR-6792** (`POST /api/work-items/{key}/hosted-runs` with `mode: 'continue'`); the
per-repository branches it names are **MOTIR-6791**; the part it extends is **MOTIR-6534**'s.

**Why it is owed.** § _Run died_ hands a dead run over as a terminal command. For the people the
hosted agent exists for — no laptop, no local setup — that is a dead end on exactly the day something
went wrong. The start path can now resume a dead run in a fresh container; this section decides
where that sits on the page and how it reads, so the button is built once against a drawing.

**Access path.** The item page only: the **continue part** in the Development card, and the run
section's died line (R1) pointing down to it. No new entry point, no new navigation, and nothing on
the Workbench To fix row (MOTIR-6590 reuses this control later).

### Composed, not redrawn

The continue part, its lines, pills, command block and start-over hint are § _Run died_'s, i.e.
`components/github/ContinuePart.tsx` as shipped; the delta's stylesheet and sprite sheet are
`run-section--run-died.mock.html`'s verbatim, plus a `cc-` block and two sprites extracted from
`lucide-react@1.16.0` (`cloud`, `chevrons-up-down`; `audit-mock-sprites --strict`: 46 symbols,
0 drifted, 0 undeclared). The door is `RunHostedButton.tsx`'s row — `HostedModelPicker` (the shipped
`Combobox`, `searchable={false}`, the default preselected by `preselectedModel`) then `Button
variant="primary" size="sm"` with the `Cloud` glyph — and the notices are `HostedDoorNotices.tsx`'s
`Notice`. The hosted run section in C4b is MOTIR-684's panel 5, abbreviated. **Nothing here is a new
primitive, a new pill variant or a second picker.**

### The panels

| panel | state                                                                                                                                   | shown when                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C1    | **Died, continuable (leaf)** — D1 plus the hosted lead, the picker and **Continue hosted**; the command follows as _Or … terminal_      | the view is `died`, `refusal === null`, `branches.length ≥ 1`, and the Run hosted door is mounted for this viewer |
| C2    | **Died, several repositories / a draft** — D2's branch line becomes a lead plus **one line per repository**, each with its pull request | as C1, and `branches.length > 1` (with one entry the shipped single line stays, `branch` / `branchWithPr`)        |
| C3    | **Child of a parent run** — D7 plus **Continue ACME-12 hosted** under the pointer, the parent's command after it                        | the view is `died` with `refusal === 'continue_the_parent'` and a `parentKey`, door mounted                       |
| C4a   | **Starting** — Button `loading` (spinner, _Starting…_), picker disabled, nothing else moves                                             | the start request is in flight                                                                                    |
| C4b   | **Started** — the part is D5 _Continuing_ (holder **you**, _in a hosted container_); the Run card is MOTIR-684's live hosted section    | the start answered `201` / `200`; the page re-read the view (`continuing`) and the run history                    |
| C5a   | **Refused, taken** — the notice names the holder and since when; the part re-read beneath it is D5                                      | `409 hosted_continue_taken`; the same shape for every refusal that means the state MOVED                          |
| C5b   | **Every answer in words** — thirteen notices                                                                                            | each 4xx / 5xx the start can give (table below)                                                                   |
| C5c   | **A pre-flight refusal in place** — out of credits; the part stays D1, the notice between the door and the terminal path                | `402` / `422` / `409 hosted_repository_not_writable` / `503`: nothing locked, nothing moved                       |
| C7    | **The Run card on a died In Progress work item** — no door in its header; R1's died line names both ways and points down                | the continue view is `died` with any refusal but `not_in_progress`                                                |

**C6 · Not offered — a note, not a panel.** No Continue hosted, and the part is exactly what ships,
when the run is **alive**, **succeeded** or the work item was **never run** (`alive` / `none`: no
part at all); when nothing was pushed (**D4**, `no_branch`); when it is **Implemented** (**D6**,
`use_fix`); when it is no longer In Progress (`not_in_progress`: no part); while a continue holds it
(**D5**); while the view is loading or failed (**D8**); and when the Run hosted door is not mounted —
the viewer cannot edit the project, the work item is archived, or its status is in the done category
(`_view.tsx`'s `hostedDoor` rule, unchanged). There D1 keeps its shipped lead, _Carry it on from your
terminal:_. **The door and the claim read one view**: the part never offers a Continue hosted the
start would refuse on what the page already knows.

### Decisions

| decision                           | chosen                                                                                                                                                           | why                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| which path is primary              | **Continue hosted** — the only `primary` Button in the part; the terminal command stays, as the second path                                                      | the story exists for the person with no terminal; for the person with one, the command is still there, still copyable, one line down                                                                                                                  |
| where the action sits              | **between** the _nothing moved_ line and the command: hosted lead → door → notice slot → _Or carry it on from your terminal:_ → command → _An agent checks out…_ | the caller's default was "after the command"; it reverses because a primary action under its alternative reads as an afterthought, and _Or …_ can only follow what it is the alternative to. _An agent checks out…_ is true of both, so it stays last |
| the terminal lead                  | `lead` → **`hosted.orTerminal`**, _Or carry it on from your terminal:_, at the quiet note size (`text-xs text-(--el-text-secondary)`) whenever the door is shown | one sentence tells the reader the two are alternatives; the size tells them which is first. Without the door the shipped `lead` is unchanged                                                                                                          |
| the door's shape                   | RunHostedButton's row — picker then button, `flex flex-wrap items-center gap-2` — inside the part, not in a header                                               | the same control in the same order everywhere a run starts; `flex-wrap` is the one addition, so at ~400px the button drops under the 15rem picker, left-aligned and never stretched                                                                   |
| the branch line with several repos | a lead (_Its work is on a branch in each of its {count} repositories:_) and one line per repository, primary first, each with its pull request when it heads one | a hosted continue resumes every repository's branch; naming one would hide work the press is about to touch. One entry keeps the shipped line, so a one-repository item renders exactly as today                                                      |
| C3 — the child of a parent run     | the button reads **Continue ACME-12 hosted** and POSTs to `parentKey`                                                                                            | mirrors D7's `motir continue <PARENT>`: what the button says is what the server continues. (The start would also redirect a child's key one hop to its parent; posting the parent's key keeps the label and the request identical.)                   |
| starting                           | Button `loading` + the reused `runs.hosted.door.starting`; the picker disabled; nothing else moves                                                               | the door's own pending grammar; a second press is impossible, and a replayed one is answered `200` with the same run                                                                                                                                  |
| after the start                    | `router.refresh()` for the part (server-read view) **and** the Run section's `runsChangedAt` tick (a client island)                                              | CLAUDE.md § _Page state after a mutation_: the part is a server surface, the run history is not, and the refresh alone does not reach it                                                                                                              |
| _continuing_ says hosted           | D5's holder line gains **in a hosted container** (`hosted.continuing.byYou` / `.by`), plus _Watch it work in Run above._ for the viewer's own                    | the person who pressed must see that nothing waits on their machine; the run section above is where it is watched, so the part says so rather than repeating it                                                                                       |
| where a refusal is drawn           | **in the continue part**, directly under the door — never in the Run section's body                                                                              | the answer belongs beside the button that asked; the Run section's notices answer the Run section's door                                                                                                                                              |
| a refusal that means state moved   | the notice stays (it answers the press) and the part re-reads its view beneath it (C5a)                                                                          | `taken`, `run_alive`, `nothing_pushed`, `use_fix`, `not_in_progress`, `no_dead_run` all mean the page is stale; showing the new state under the answer is truer than keeping a door the server just refused                                           |
| a pre-flight refusal               | the part stays D1, the notice sits between the door and the terminal path (C5c)                                                                                  | the start runs every pre-flight before it takes the claim (MOTIR-6792), so nothing was locked — the terminal command still works, and out-of-credits' body says so                                                                                    |
| the refusal tone                   | HostedDoorNotices' **warning** Notice for every answer, including boot failed                                                                                    | the door's own rule: nothing failed that the reader did, nothing was charged; a danger red would misreport a refusal as a loss                                                                                                                        |
| C7 — Run hosted on a died item     | **hidden**, header and body lines both, whenever the view is `died` with any refusal but `not_in_progress`; R1's died line is the pointer                        | the server refuses it (`hosted_run_card_not_ready`: the item is In Progress), and two contradictory ways forward on one page is the defect. A live hosted continue still shows _Cancel run_ there (C4b)                                               |
| C7's pointer copy                  | `hosted.runDied` — _…continue it hosted or from a terminal in Development below._ — only while the part offers Continue hosted; `runs.runDied` otherwise         | the pointer names what is actually below; on D4 / D6 / no door, the shipped line stands                                                                                                                                                               |

### Fields read

| rendered element                                         | field(s) read                                                                                                                                                                                                              | panel     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| whether the action renders                               | `WorkItemContinueViewDto.state === 'died'`, its `refusal` (`null` → C1/C2, `continue_the_parent` → C3; anything else → none), `branches.length ≥ 1`; and the page's `hostedDoor` (edit permission, not archived, not done) | C1–C3, C6 |
| the button's target and label                            | the page's item key (C1/C2); the view's `parentKey` (C3)                                                                                                                                                                   | C1–C3     |
| the branch line(s)                                       | the view's `branches: ContinueBranchDto[]` — per entry `repository`, `branch`, `pullRequest.repo` + `.number`; one entry → the shipped `branch` / `branchWithPr` line                                                      | C1, C2    |
| the picker                                               | `GET /api/hosted-runs/models` → `models[] { id, provider }`, `default` (shipped `HostedRunProvider`, one read for the page)                                                                                                | C1–C5     |
| the start                                                | `POST /api/work-items/{key}/hosted-runs` body `{ model, mode: 'continue', idempotencyKey }` — one idempotency key per press                                                                                                | C4a       |
| started                                                  | `201 { dispatchRunId, created: true }`, or `200 { …, created: false }` for the same press replayed → re-read the view and the run history                                                                                  | C4b       |
| _continuing_, hosted                                     | the view's `continuing` — `holder`, `byViewer`, `startedAt`, `branches`, `tookOverFrom` — **and a new `origin: 'local' \| 'hosted'`** of the open `continue` run (see TAKES)                                               | C4b, C5a  |
| taken                                                    | `409 hosted_continue_taken` + `holder { id, name }` + `startedAt`; _you_ when `holder.id` is the viewer                                                                                                                    | C5a, C5b  |
| run alive                                                | `409 hosted_continue_run_alive` + `holder` + `startedAt`                                                                                                                                                                   | C5b       |
| nothing pushed · use fix · not In Progress · no dead run | `409 hosted_continue_nothing_pushed` · `_use_fix` · `_not_in_progress` · `_no_dead_run` (code only)                                                                                                                        | C5b       |
| continue the parent                                      | `409 hosted_continue_the_parent` + `parentKey`                                                                                                                                                                             | C5b       |
| model not offered                                        | `422 hosted_model_not_offered` — the model named is the one the viewer chose; the picker re-reads its list                                                                                                                 | C5b       |
| out of credits                                           | `402 hosted_run_out_of_credits` (+ `balanceCredits`, not drawn) or `402 CI_CREDITS_EXHAUSTED`                                                                                                                              | C5b, C5c  |
| repository not writable                                  | `409 hosted_repository_not_writable` + `repositories[] { repository, reason, fix, fixUrl }` + `totalRepositories`                                                                                                          | C5b       |
| unavailable                                              | `503 hosted_run_unavailable` (and `hosted_models_unavailable` / `hosted_run_credits_unavailable`, which read the same)                                                                                                     | C5b       |
| boot failed                                              | `503 hosted_run_boot_failed` + `dispatchRunId` — a run was opened and ended; the history and the view are re-read (the part is continuable again)                                                                          | C5b       |
| failed                                                   | no answer, or any other status                                                                                                                                                                                             | C5b       |
| C7 — the door hidden                                     | the same `WorkItemContinueViewDto` the part reads (`state`, `refusal`), handed to the Run card                                                                                                                             | C7        |

### Tone and tokens

`--el-*` colour and element-semantic shape tokens only; each `cc-` rule in the delta quotes the class
string MOTIR-6796 builds it from, and every other rule is § _Run died_'s. The hosted lead: 13px
`--el-text` (the shipped `lead`). _Or carry it on…_: `--el-text-secondary` at 12px. The picker: the
shipped Combobox trigger — `--height-control`, `--radius-input`, `--el-border` on `--el-page-bg`, the
default's secondary in `--el-text-identifier`, disabled on `--el-surface-soft` in
`--el-text-secondary`. The button: `--el-accent` / `--el-accent-text`, `--height-btn-sm`,
`--radius-btn`, disabled at 50% opacity. The notices: `--el-warning-surface` ground, `--el-text-strong`
ink, `--el-warning` glyph, `--radius-control`, `--spacing-control-x/y`. The per-repository lines:
`--el-text-secondary`, repository names in `--el-text`, branches in the mono face. The hosted phase
in progress: `--el-status-in-progress` dot. No new token.

### Copy — `en` + `zh`

New strings live under **`github.development.continue.hosted`**. Reused BY NAME, unchanged:
`runs.hosted.door.starting`; `runs.hosted.picker.*`; `runs.hosted.refused.modelNotOffered.*`,
`.notWritable.*`, `.unavailable.*`, `.bootFailed.*`, `.failed.*`, `.outOfCredits.title`; and
`runs.hosted.refused.notReady.body` (_Nothing was booted and nothing was charged._) as the body of
every continue-specific refusal — the same sentence with the same meaning. The rest of the part is
`github.development.continue.*` as shipped.

| key (`github.development.continue.hosted.…`) | en                                                                                                                                                | zh                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lead`                                       | Continue it here, in a hosted container — no terminal needed:                                                                                     | 在这里用托管容器继续——无需终端：                                                                               |
| `button`                                     | Continue hosted                                                                                                                                   | 托管继续                                                                                                       |
| `buttonParent`                               | Continue {key} hosted                                                                                                                             | 托管继续 {key}                                                                                                 |
| `orTerminal`                                 | Or carry it on from your terminal:                                                                                                                | 或者在终端中继续：                                                                                             |
| `branches.lead`                              | Its work is on a branch in each of its {count} repositories:                                                                                      | 其工作位于它的 {count} 个代码仓库各自的分支上：                                                                |
| `branches.row`                               | <b>{repository}</b> · <ref>{branch}</ref>                                                                                                         | <b>{repository}</b> · <ref>{branch}</ref>                                                                      |
| `branches.rowWithPr`                         | <b>{repository}</b> · <ref>{branch}</ref> · pull request <b>{pr}</b>                                                                              | <b>{repository}</b> · <ref>{branch}</ref> · 拉取请求 <b>{pr}</b>                                               |
| `continuing.byYou`                           | Being continued by <b>you</b> in a hosted container · started <when></when>                                                                       | <b>你</b>正在用托管容器继续 · <when></when>开始                                                                |
| `continuing.by`                              | Being continued by <b>{name}</b> in a hosted container · started <when></when>                                                                    | <b>{name}</b> 正在用托管容器继续 · <when></when>开始                                                           |
| `continuing.watch`                           | Watch it work in Run above.                                                                                                                       | 在上方的“运行”中查看其进度。                                                                                   |
| `refused.taken`                              | Not started — <b>{name}</b> is already continuing this work item, since <when></when>.                                                            | 未启动——<b>{name}</b> 已在继续此工作项（<when></when>开始）。                                                  |
| `refused.takenByYou`                         | Not started — you are already continuing this work item, since <when></when>.                                                                     | 未启动——你已在继续此工作项（<when></when>开始）。                                                              |
| `refused.runAlive`                           | Not started — <b>{name}</b>'s run is still reporting, so there is nothing to continue.                                                            | 未启动——<b>{name}</b> 的运行仍在上报，因此没有可继续的内容。                                                   |
| `refused.nothingPushed`                      | Not started — the run pushed nothing to continue from.                                                                                            | 未启动——该运行没有推送任何可继续的内容。                                                                       |
| `refused.useFix`                             | Not started — the pull request is open, so its checks decide from here.                                                                           | 未启动——拉取请求已打开，接下来由其检查决定。                                                                   |
| `refused.notInProgress`                      | Not started — this work item is not In Progress any more.                                                                                         | 未启动——此工作项已不再是进行中。                                                                               |
| `refused.noDeadRun`                          | Not started — no run of this work item died.                                                                                                      | 未启动——此工作项没有中断的运行。                                                                               |
| `refused.theParent`                          | Not started — this is part of <link>{key}</link>'s run, so it is continued from there.                                                            | 未启动——它是 <link>{key}</link> 运行的一部分，因此从那里继续。                                                 |
| `refused.outOfCredits.body`                  | Nothing was booted and nothing was charged. Continue hosted works again once the organization has credits — or carry it on from your terminal.    | 没有启动任何机器，也没有产生任何费用。组织有积分后即可再次托管继续——或者在终端中继续。                         |
| `runDied`                                    | This run died — last heard from <b><when></when></b>. Its work is kept on its branch; continue it hosted or from a terminal in Development below. | 此运行已中断——最后一次联系在<b><when></when></b>。其工作保留在分支上；请在下方“开发”中托管继续或在终端中继续。 |

`<when>` is `relativeLabel` on a `<time datetime>` with `formatRunInstant` in `title` (§ _Run died_'s
clock); `<ref>` is the mono branch tag; `{pr}` is the row's `repo · #n`; `{count}` is
`branches.length`. `runDied` replaces `runs.runDied` only while the part offers Continue hosted.

### Scope

**Drawn:** the Continue hosted action in the continue part (leaf, several repositories, child of a
parent run), its pending and started states, every answer the start can give, the not-offered rule,
and the Run card on a died work item. **Not drawn, and whose it is:** the component, the door state
shared between the Run card and Development, and the Run card change — **MOTIR-6796**; the start
path and its refusal codes — **MOTIR-6792**; the per-repository branch data — **MOTIR-6791**; the
acceptance video — **MOTIR-6798**; the model picker, the hosted run section and the run-died panels
themselves — unchanged, composed; the Workbench To fix row — **MOTIR-6590**.

### GIVES / TAKES

| key        | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-6796 | **GIVES** every panel (C1–C5, C7), the C6 rule, the copy and the tokens above. **TAKES** (1) the Continue hosted door INSIDE `ContinuePart` — `HostedModelPicker` + a primary `Button`, one idempotency key per press, `mode: 'continue'`, POST to the item key or `parentKey`; (2) ONE models read for the page — `HostedRunProvider` today wraps only the Run card, so it moves up to wrap Development too (or the read is lifted), with the continue door's start / refusal state kept separate from Run hosted's; (3) the refusal mapping in the Fields-read table, drawn in the part, with a `router.refresh()` + `runsChangedAt` bump on success, boot-failed and every state-moved refusal; (4) `origin: 'local' \| 'hosted'` on the view's `continuing` branch (`getContinueView` reads it from the open `continue` run) for C4b's _in a hosted container_; (5) the Run card hides `RunHostedButton` and `HostedDoorNotices` when the continue view is `died` with any refusal but `not_in_progress`, and R1 uses `hosted.runDied` while the part offers Continue hosted; (6) the `en` + `zh` strings above |
| MOTIR-6798 | **GIVES** the script: R1 + C1 on a killed hosted run → press **Continue hosted** → C4a → C4b (the part _Continuing_ by you, the Run card's hosted phases) → a second viewer sees C5a (_taken_, naming the first). **TAKES** that each state carries `data-state` on the part (`died` / `continue_the_parent` / `continuing`, as shipped) and the door a `data-testid="continue-hosted-door"`, so the spec waits on the authoritative signal — the start's `201` response, then the part's `data-state="continuing"` — never on the optimistic button                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MOTIR-6534 | **GIVES** the part this amends (D1, D2, D5, D7, R1), unchanged wherever the door is not shown. **TAKES** nothing new — it is shipped; its `lead` line and `runs.runDied` stay the strings for every viewer and state C6 lists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| MOTIR-6792 | **GIVES** nothing drawn. **TAKES** that the 409 bodies carry what the notices name — `holder { id, name }` + `startedAt` on `hosted_continue_taken` and `_run_alive`, `parentKey` on `hosted_continue_the_parent` — as the route answers today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| MOTIR-6791 | **TAKES** that `branches[]` is primary-first with each entry's own `pullRequest`, so C2's lines are a straight read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| MOTIR-6789 | this card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Fixture items use `ACME-n` keys: **ACME-14** a leaf, **ACME-12** the story whose parent run it
belonged to (in two repositories, `motir-core` and `motir-ai`), **ACME-9** ACME-12's own parent.

## Run hosted — the picker says where its model came from (MOTIR-6991, 2026-09-30)

**AMENDS** MOTIR-684's approved Run hosted design (the published `run-section--hosted.mock.html`,
§ _The model picker_) and the door as § _Continue hosted — the browser resumes a dead run_ composes it
([`development--continue-hosted.mock.html`](./development--continue-hosted.mock.html), `.cc-door`) —
in the delta **[`run-section--from-difficulty.mock.html`](./run-section--from-difficulty.mock.html)**,
Panels **F1–F6**, each the Run card's HEADER only. Card MOTIR-6991. **No existing mock is edited**,
and no image export ships. Its sibling is the Hosted agent settings room,
[`../settings/hosted-agent.mock.html`](../settings/hosted-agent.mock.html) (§ _Hosted agent room_ in
`design/settings/design-notes.md`).

**What changes.** The model Run hosted PRESELECTS is now resolved from the work item's difficulty —
a leaf's own, a parent's highest among its leaves — through the project's Hosted agent settings (an
override if one is stored and still offered, else that difficulty's platform default). The picker
therefore gains **one line** saying where the preselection came from. With no difficulty there is no
line, and today's picker stands exactly as approved: Motir AI's single default, preselected and
marked _Default_.

### Composed, not redrawn

`HostedModelPicker` — the shipped `Combobox`, `searchable={false}`, the model id as label, the
provider (or _Default · {provider}_ for Motir AI's default) as `secondary` — and the primary sm
`Button` with the `Cloud` glyph are the approved door, unchanged. The trigger is drawn as
`development--continue-hosted.mock.html` draws it (mono value, _Default_). The token, chrome and
primitive layers are spliced verbatim from `design/projects/bug-destination.mock.html`. **The one
new element is the line**; the one new use of a shipped prop is the option's `description`.

### The panels

| panel | state                                                                                                                               | the line                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| F1    | **Leaf, difficulty High, no override** — `claude-opus-5-5`, which is also Motir AI's default, so the _Default_ label stays          | _From difficulty: High_                               |
| F2    | **Leaf, High overridden** to `claude-fable-5-1` by the project — secondary reads the provider                                       | _Project override for High_                           |
| F3    | **Parent work item** (a story whose leaves are Low, Medium, High)                                                                   | _Highest difficulty among its leaves: High_           |
| F4    | **Leaf with no difficulty** — exactly the approved picker                                                                           | absent                                                |
| F5    | **The menu, open** on F1 — the preselected option carries the line as its `description`; rows keep their shipped secondary + footer | under the option's label, and under the trigger       |
| F6    | **After the person picks another model** (`claude-opus-5`)                                                                          | removed — it describes the preselection, not the pick |

**Stated, not drawn.** A parent AND an override: _Project override for High, the highest difficulty
among its leaves_. A parent none of whose leaves has a difficulty: no line (F4). Leaves with no
difficulty are left out of a parent's maximum. A **withdrawn** override (the stored model is no
longer offered) preselects the platform default, so the line reads _From difficulty: {difficulty}_
— the room says why (its Panel 4); the picker does not repeat it. The ~400px door is the approved
wrap (`flex-wrap`): the picker keeps 15rem, the button follows, and the line stays last.

### Decisions

| question                    | decision                                                                                                                                  | why                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| where the line sits         | the LAST child of `RunHostedButton`'s row, `basis-full`, under the picker and free to run under the button; the row becomes `items-start` | inside the picker's 15rem column the parent line wraps to two; the row's own width holds it on one. `items-start` keeps the button level with the TRIGGER, not with the trigger + line |
| the trigger                 | unchanged: label + `secondary`                                                                                                            | the `Combobox` trigger never renders `description`, and the 15rem trigger has no room for a second fact                                                                                |
| _Default_ vs the line       | **both**, never one for the other                                                                                                         | _Default_ is a fact about the MODEL (Motir AI's single default); the line is a fact about the CHOICE. F1 shows a model that is both                                                    |
| after a manual pick         | the line goes; it comes back if the preselected model is re-picked                                                                        | a line under a model it does not explain is a false statement                                                                                                                          |
| the override line as a link | **not** a link                                                                                                                            | the room is one rail row away for anyone who can press Run hosted (the room's view key is `work_item:edit`); a link in a 12px caption beside a primary button is a mis-tap target      |
| accessibility               | the line has an id and is the trigger's `aria-describedby`                                                                                | a screen-reader user hears why the model was chosen when the picker is focused                                                                                                         |

### Tone and tokens

| element                     | primitive                    | colour (`--el-*`)                                                                                                                                                | shape                                                                                  |
| --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| the line                    | `<p>` in the door row        | `--el-text-secondary` (AA on every surface); the difficulty in `--el-text`, weight 600                                                                           | —                                                                                      |
| trigger                     | `Combobox`                   | `--el-page-bg`, `--el-border`; value `--el-text`; secondary `--el-text-identifier`; chevron `--el-icon-muted`                                                    | `--radius-input`, `--height-control`, `--spacing-control-x`                            |
| menu · option `description` | `Combobox` panel             | `--el-page-bg`, `--el-border`; active `--el-option-active-bg`; `description` `--el-text-secondary`; check `--el-accent-on-surface`; footer `--el-text-secondary` | `--radius-card`, `--shadow-elevated`; rows `--radius-control`, `--spacing-control-x/y` |
| Run hosted                  | `Button` primary sm, `Cloud` | `--el-accent`, `--el-accent-text`                                                                                                                                | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm`                                |
| Run card header             | `ContentSectionCard`         | `--el-card`, `--el-border`, divider `--el-border-soft`; title `--el-text`; sub `--el-text-secondary`                                                             | `--radius-card`, `--shadow-subtle`, `--spacing-card-padding`                           |

### Copy — `en` (`runs.hosted.picker.*`, proposed)

| key                  | string                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `fromDifficulty`     | From difficulty: <b>{difficulty}</b>                                              |
| `override`           | Project override for <b>{difficulty}</b>                                          |
| `fromLeaves`         | Highest difficulty among its leaves: <b>{difficulty}</b>                          |
| `overrideFromLeaves` | Project override for <b>{difficulty}</b>, the highest difficulty among its leaves |

`{difficulty}` is the shipped `labels.difficulty.*` label. The existing picker keys (`label`,
`defaultSecondary`, `footer`, the three trigger faces) are unchanged. `zh` follows in the build
card, in the same keys.

### Fields read

The door's existing read (`GET /api/hosted-runs/models` → `models[] { id, provider }`, `default`) plus,
for the work item on the page, the resolved preselection: **the model, its source (`difficulty` ·
`override`), the difficulty it was resolved from, and whether that difficulty is the item's own or
its leaves' maximum** — so the line is a straight read and the client never re-derives the mapping.
A withdrawn override resolves server-side to `source: difficulty`.

### Scope

**Drawn:** the line in its three wordings, its absence, its place in the open menu and its removal on
a manual pick. **Not drawn:** the settings room (its own section, `design/settings/`); the resolution
itself and where it is computed — the build card's; the Continue hosted door, which composes the same
picker and inherits the line with no drawing of its own; the Workbench To fix row (MOTIR-6590), which
reuses the control likewise.

### GIVES / TAKES

| to                                      | GIVES / TAKES                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the build card(s) blocked by MOTIR-6991 | **GIVES** F1–F6, the stated cases, the decisions, the copy and the tokens. **TAKES** the resolved preselection above on the door's read, and a `provenance` prop on `HostedModelPicker` (rendered by `RunHostedButton` as the row's last child, `aria-describedby` on the trigger). |
| MOTIR-684 / MOTIR-6789                  | **GIVES** nothing back: their door is composed unchanged except for the line. **TAKES** nothing.                                                                                                                                                                                    |

## Run in my agent — a work item sent to one of the developer's own agents (MOTIR-7022, 2026-09-30)

**Story MOTIR-6864 · design MOTIR-7022.** Gates **MOTIR-7028** (the work item's control, picker, run
section and run modal) and **MOTIR-7029** (the My agents panel). Two DELTA mocks:

| Delta                                           | Amends                                                                                                                                                                                                                                                                                                                                        | Panels                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`design/runs/run-section--agent.mock.html`**  | MOTIR-684's published result — **`run-section--hosted.mock.html`** and **`run-modal--hosted.mock.html`** (evidence `cmuir8l3w0005hvoiahjxjlkt`, § _Hosted runs_ of that result's notes — published, not committed to this tree; `get_design MOTIR-684` returns them) — themselves deltas on `run-section.mock.html` and `run-modal.mock.html` | (revision 2) 0 the two ways to start · 1 the picker · 2 **the agent already working on a work item** · 3 every agent state and row reason · 4 the start bar's other states · 5 send refusals · 6 wake refusals · 7 starting · 8 running and succeeded · 9 every other end · 10 cancel · 11 the run Motir works, renamed · 12 the modal |
| **`design/my-agents/my-agents--run.mock.html`** | MOTIR-6937's published result — **`design/my-agents/my-agents--panel.mock.html`** (evidence `cmun5qu1f005qhwoiq14livtw`, commit `5bf46803`), whose notes leave _"Run in my agent (MOTIR-6864)"_ to this card                                                                                                                                  | 1 live run and its session to watch · 2 Hibernate and Delete during a run · 3 the run just ended · 4 the narrow width                                                                                                                                                                                                                  |

> **Revised — see § _Revision 2_ below.** The reviewer sent revision 1 back. Revision 2 replaces this
> section's door names (_Run in my agent_ → **Send to my agent**, _Run hosted_ → **Run**), moves both
> doors out of the section header into a start bar, draws the busy agent in its own panel, renames the
> refusal family (_Not started —_ → **Not sent —**), and takes "hosted" out of every string it draws.
> Where this section and Revision 2 disagree, Revision 2 is the design.

Neither mock redraws what it amends. The runs delta copies `run-modal--hosted.mock.html`'s four
`<style>` blocks verbatim (the base assets' blocks + the hosted rules) and adds one block of agent
rules; the panel delta copies `my-agents--panel.mock.html`'s five blocks verbatim and adds one. Both
were checked against what ships: `RunHostedButton.tsx`, `HostedDoorNotices.tsx`, `LateSections.tsx`,
`ContentSectionCard.tsx`, `RunSection.tsx`, `HostedRunParts.tsx` and `RunModal.tsx` for the work
item; `AgentPanelHeader.tsx`, `AgentTerminal.tsx` and `agentRefusal.tsx` for the panel; and the
shipped `runs.hosted.*` / `myAgents.*` strings, which this design reuses wherever the meaning is the
same. (The hosted end lines that ship are _"… This work item stays where it was"_, per
`run-death-keeps-work.md`, not the _"back in To Do"_ lines the hosted mock drew; this delta draws the
shipped ones.)

### The behaviour is decided elsewhere, and drawn here

`docs/decisions/agent-instance-run.md` (MOTIR-7021) decides everything this design shows: §1 the run
session (at most one per agent, listed to every connection, watch-only), §4 the start's checks, the
agents read and the refusal set, §5 the record (`origin: instance`, the agent on the run, `model =
null`, machine time only), §6 the live run, every end and Cancel. The wake refusals and their words
are `agent-instances.md` §5 as reworded by `agent-instance-storage.md` §4 (MOTIR-6914). **On screen
the thing is an _agent_ and its _coding agent_, never an "instance".**

### Access path (panel 0) — the Run section's header, left of Run hosted

- **Where:** `ContentSectionCard`'s `headerRight` on the Run section — the slot `RunHostedButton`
  renders into — at the head of the item page's late stack, directly before Development.
- **Order:** **Run in my agent** · the model picker · **Run hosted**. Run hosted keeps the right end
  it shipped with and stays the header's one primary button. Run in my agent is `Button` `secondary`
  `sm` with the `SquareTerminal` glyph and a trailing `ChevronDown`, because it opens a choice.
- **Where the hosted lane is off** (`hostedDoor` null) the header carries Run in my agent alone.
- **Shown to:** anyone who can edit the work item where My agents exists (the rail entry's own
  condition). A person with no agent on the project still sees it (panel 3).
- **The header wraps.** Three controls do not fit beside _Run — what the agent did_ at the item page's
  column width, so `ContentSectionCard`'s header row gains `flex-wrap` (row gap 8px) and the gloss
  becomes `whitespace-nowrap`: the door group drops to its own line, still right-aligned. This is a
  change to a shared component (every section using `headerRight`); at a width where everything fits
  nothing moves.

### The picker (panels 1, 2)

The shipped `Popover` (`--radius-card`, `--shadow-elevated`, `--el-page-bg`, `--el-border`, 25rem),
anchored under the control, right-aligned. Head: **Run {KEY} in one of your agents** · _Choosing an
agent starts the run. An agent that is asleep wakes first._ One row per agent from `GET
/api/work-items/[id]/agent-runs/agents` (decision §4), in My agents' order; foot: _Only your agents on
{project} are listed._ · **Manage in My agents**.

- **Row:** the name (600, `--el-text`), the state pill (`RunTonePill` + `AGENT_STATE_TONE`, the list's),
  a sub-line _{coding agent} · {sign-in} · {what happens first}_ in `--el-text-secondary`, and — only
  when it cannot take the run — a reason line in `--el-text` with a link where there is somewhere to
  go. Row metrics are the Combobox listbox's option (`--spacing-control-x/y`, `--radius-control`); the
  focused row is `--el-option-active-bg`.
- **There is no Start button.** Pressing a row that can take the run IS the start; the popover closes
  on the answer (panel 6). Arrows skip a disabled row; Enter starts; Esc closes and returns focus.
- **A row that cannot take the run stays listed**, `aria-disabled`, its name dropped to
  `--el-text-secondary`, its reason in full ink. An agent that vanished from the list would read as an
  agent that is gone.
- **Agents on other projects are NOT listed.** An agent is made for one project and holds that
  project's repositories; its row could never be chosen. The footer says so. The
  `agent_instance_wrong_project` refusal keeps its words for a stale list (panel 4).
- **Sign-in is the recorded probe** (§4): _Signed in_ (`CircleCheck`, `--el-success`), _Not signed in_
  (`CircleAlert`, `--el-warning`), _Sign-in can't be checked_ (`CircleHelp`, `--el-text-secondary`).
  Signed in and can't-be-checked may start; not signed in may not. Glyphs are `aria-hidden`; the words
  carry the state.

**Every `AgentInstanceState` (panel 2):**

| State         | Pickable | Sub-line ends with                  | Reason line                                                                       |
| ------------- | -------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `running`     | yes      | _starts now_                        | —                                                                                 |
| `hibernated`  | yes      | _wakes first_                       | —                                                                                 |
| `starting`    | yes      | _starts when it's up_               | — (§4: the launch job waits)                                                      |
| `waking`      | yes      | _starts when it's up_               | —                                                                                 |
| `failed`      | yes      | _wakes first — it failed last time_ | — (the wake is the same one My agents' **Wake** runs on a failed agent)           |
| `hibernating` | no       | —                                   | _It's stopping. Choose it again once it's hibernated — it will wake for the run._ |
| `deleting`    | no       | —                                   | _It's being deleted._                                                             |

**Every row reason the read knows before a press (panel 2):**

| Reason (code)                                      | Reason line                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a run already in it (`agent_instance_run_active`)  | _Already running **{key}**. One run at a time in an agent — wait for it, or cancel it there._ (`{key}` links to the work item)                                                                                                                                                  |
| not signed in (`agent_not_signed_in`)              | _Sign in first: open {name} and run `{command}` in its terminal._ **Open {name}** — the command per coding agent is `myAgents.panel.signin.signedOut.*`'s (claude: `claude`, then its login slash command; codex: `codex login --device-auth`; opencode: `opencode auth login`) |
| image too old (`agent_instance_image_too_old`)     | _Made from an older image that can't run work items. Moving it to the newer image — keeping its home and sign-in — is on its way; a new agent can run them now._ No button: MOTIR-6862's update flow is not drawn here                                                          |
| no unattended command (`agent_profile_cannot_run`) | _{coding agent} can't run a work item on its own — it has no unattended mode Motir can start._                                                                                                                                                                                  |

### The control's other states (panel 3)

- **No agent on the project:** the control opens; the popover reads **You have no agent on {project}
  yet.** · _An agent is your own coding agent — Claude Code, Codex and others — on your own sign-in, in
  Motir's cloud. Make one for this project, sign it in, and this work item can run in it._ ·
  **Create one in My agents** (`Button` secondary, a link to `/my-agents`). It does not open the create
  dialog in place.
- **Not ready:** both doors disabled in place; ONE body line for both — _Run in my agent and Run
  hosted are available once this work item is ready — it has {n} open blockers._ (the agent door
  alone: _Run in my agent is available once …_). It replaces `runs.hosted.notReady` while both show.
- **A run is live on the work item, any lane:** the control gives way, as Run hosted does. A live
  hosted run → **Cancel run**; a live run in an agent → **Cancel run** for the agent's OWNER, nothing
  for anyone else (§6: only the owner reaches an agent); a live local run → nothing.

### Refusals live on the DOOR (panels 4, 5)

Every check in §4 runs before the run is opened, so a refusal leaves no run: no history row, nothing
in `/runs`, nothing for the modal. It is the hosted door's `notice warn` (`--el-warning-surface`,
`--el-warning` glyph, `--el-text-strong`) in the section body. **The family:** every title begins
**Not started —**, every body ends _Nothing was started and nothing was charged._ The picker re-reads
its list on any refusal. `hosted_repository_not_writable` is the hosted door's shipped notice,
unchanged.

| Code (HTTP)                           | Title                                                                        | Body                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `agent_not_signed_in` (409)           | Not started — {coding agent} isn't signed in on {name}.                      | Open {name} and run `{command}` in its terminal. + the family ending · **Open {name}**                                    |
| `agent_instance_wrong_project` (409)  | Not started — {name} works on another project.                               | An agent runs work items only from the project it was made for. Choose an agent on {project}, or create one in My agents. |
| `agent_run_card_not_ready` (409)      | Not started — this work item isn't ready to run.                             | the reason it carries (_It has {n} open blockers._ / _It's {status}._)                                                    |
| `agent_instance_run_active` (409)     | Not started — {name} is already running **{key}**.                           | One run at a time in an agent. Wait for it to finish, cancel it, or choose another agent.                                 |
| `agent_instance_image_too_old` (409)  | Not started — {name} was made from an older image that can't run work items. | Moving it to the newer image — keeping its home and sign-in — is on its way. Until then, a new agent can run work items.  |
| `agent_profile_cannot_run` (409)      | Not started — {coding agent} can't run a work item on its own.               | It has no unattended mode Motir can start. Choose an agent with another coding agent.                                     |
| `agent_instance_state_conflict` (409) | Not started — {name} is hibernating. / … is being deleted.                   | Choose it again once it's hibernated — it will wake for the run. (deleting: no second sentence)                           |
| `agent_instance_not_found` (404)      | Not started — that agent isn't available.                                    | It may have been deleted. The list has been refreshed. (one answer for "not yours" and "gone", so nothing leaks)          |
| `permission_denied` (403)             | Not started — you can't run this work item in an agent.                      | That needs edit access to the work item and permission to use agents on this project.                                     |

**The wake's refusals, passed through UNCHANGED (panel 5).** Title **Not started — {name} couldn't
wake.**; body = the wake's own sentence, word for word, from `myAgents.refusal.*` (as MOTIR-6914
rewords them), then the family ending. So My agents' **Wake** and this door can never disagree.

| Wake refusal                          | Body (the wake's own words)                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credits` (402)                       | Your organization is out of credits. Agents use credits while they run and for their storage every day, asleep or not. **Add credits** to create or wake an agent. |
| `credits_unknown` (503)               | Motir could not check your organization's credits just now. Try again in a moment.                                                                                 |
| `fleet_busy` (429)                    | Motir is running as many machines as it can right now. Try again in a few minutes.                                                                                 |
| `org_running_limit` (429, MOTIR-6926) | Your organization is running {limit} of its {limit} agents. Hibernate one to start another. (replaces `fleet_busy` when it ships)                                  |
| `ai_plan_required` (MOTIR-6914)       | Agents need a paid AI plan (Standard, Pro, Max or Enterprise). **Choose an AI plan** to create or wake one.                                                        |
| `ai_plan_unknown` (MOTIR-6914)        | Motir could not check your organization's AI plan just now. Try again in a moment.                                                                                 |
| `agent_instances_unavailable` (503)   | My agents aren't available on this deployment.                                                                                                                     |

**Not drawn: `user_cap`.** It is a CREATE refusal (`agentInstanceLifecycleService.create`); a wake
never raises it, so it cannot reach this door. The card listed it among the wake refusals; the code
says otherwise.

### Starting (panel 6)

- **During the press:** the chosen row shows the Button's loading state; the control reads
  **Starting…** (`runs.hosted.door.starting`); Run hosted is disabled.
- **On the answer** (the route answers with the run id at once, §4): the popover closes, the header
  becomes **Cancel run**, the pill **Running**, and the six hosted phases appear with **Starting**
  current. **No new phase, status or event kind** — waking is part of Starting, and its detail line
  says which: _Waking {name}_ when the pressed row was `hibernated` or `failed`, _Starting in {name}_
  otherwise. The builder takes that from the pressed row; nothing is re-read to draw it.
- The first CLI event (`checkout_ready`) moves it to **Cloned**. A live sign-in probe that finds the
  agent signed out after the wake closes the run **Failed** (panel 8).

### The run in the section and the modal (panels 7–10)

- **The agent, three times:** the **In my agent** lane chip (the hosted chip's shape and ground,
  `--el-chip-bg` / `--el-text-strong`, the `SquareTerminal` glyph); the line _Working in **{name}** ·
  {coding agent}_ + **Watch it in My agents** (ended: _Ran in **{name}** · {coding agent}_ + **Open
  {name}**), both linking `/my-agents?agent=<id>`; and the meta row **Lane** In my agent · **Agent**
  {name} (the same link) · **Coding agent** {label} · **Elapsed**/**Took**. **No Model** (§5,
  `model = null`). The Running phase's detail is _{coding agent} · {name}_.
- **The cost is ONE figure — Machine time** — the run's own duration, `--el-surface-soft` figure as
  the hosted block draws it, with the line _{name}'s running time — charged with the agent, in
  credits. No tokens: {coding agent} runs on your own sign-in._ **No Tokens and no Credits figure**:
  §5 mints no gateway key and writes no usage row, and the credits land on the agent's interval (My
  agents' list shows them). The head reads _So far — updating while the run is live_ while live.
- **Ends** use the shipped `runs.hosted.end.*` line, the RECORDED reason verbatim in mono, and
  `end.stays`:

| `DispatchRunStatus` | Pill      | End line                                              | Recorded reason (the record's, §6)                                      | Timeline mark       |
| ------------------- | --------- | ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------- |
| `running`           | Running   | —                                                     | —                                                                       | current phase       |
| `succeeded`         | Succeeded | _The run delivered its work._ + pull request headline | —                                                                       | all done            |
| `failed`            | Failed    | _The agent exited without a pull request._            | `agent exited with code {n}`                                            | danger on its phase |
| `failed`            | Failed    | _The run's machine stopped before the run closed._    | `the agent stopped` · `the agent's machine was lost` · `out of credits` | danger              |
| `failed`            | Failed    | _The run couldn't start in the agent._ (new)          | `the coding agent is not signed in`                                     | danger on Starting  |
| `cancelled`         | Cancelled | _The run was cancelled._                              | `cancelled by {name}`                                                   | pending after       |
| `timed_out`         | Timed out | _The agent stopped producing output._                 | `stalled: no agent output for 15 minutes`                               | warning (`is-late`) |
| `timed_out`         | Timed out | _The run reached its time limit._                     | `timed out after 12 hours` (the backstop; MOTIR-7027 fixes the string)  | warning (`is-late`) |

After every end the doors return: **Run in my agent** (never "again" — the next run may be in
another agent) and **Run hosted** / **Run hosted again** by the hosted rule.

- **Cancel (panel 9):** the hosted **Cancel run** in the same places, owner only; the shipped `Modal`
  `sm`: **Cancel this run?** · _The run's session in {name} stops and its credentials are revoked. Work
  it already pushed stays on the run's branch, and this work item stays where it is. {name} keeps
  running, and your own shells in it are untouched._ · **Keep running** (secondary, focused) ·
  **Cancel run** (danger).
- **The modal (panel 10):** title **Run in my agent** `{KEY}`; second line the lane chip · _{name} ·
  {coding agent}_ (name linked) · _started {time}_; pill, then **Cancel run** (live, owner). The strip
  under the header: **Cost so far** · _updating_ · _Machine time {d} · {name}'s running time, charged
  with the agent_ · _No tokens — {coding agent} runs on your own sign-in_ (ended: **Cost**). The log pane
  keeps the hosted phase chip; its footer: _A run in your agent always reports its output._ · _Deleted
  after 30 days._ An end shows its end line and recorded reason in a strip under the header.

### The My agents panel (the second mock) — summary

Spec in `design/my-agents/design-notes.md` § _The agent's live run_. In short: a run line in the
header (**Running a work item** · key · title · **Open run**, on `--el-tint-sky`; after the end **Last
run** on `--el-muted` with the end pill and the recorded reason); the run's session offered in a
`Segmented` at the head of the Terminal tab (**Your shell** | **Run {key}**), watch-only with a sky
strip; Hibernate and Delete off during the run with the reason, and the refusal box if pressed from
elsewhere; the ended session's last screen with **Back to your shell**; the narrow full view.

### Primitives and tokens

| Element                  | Primitive                          | Tokens                                                                                                                    |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Run in my agent**      | `Button` secondary `sm`            | `--el-page-bg`, `--el-button-border`, `--el-text`, `--height-btn-sm`, `--radius-btn`, `--spacing-btn-x-sm`                |
| the picker               | `Popover`                          | `--el-page-bg`, `--el-border`, `--radius-card`, `--shadow-elevated`; rules `--el-border-soft`                             |
| a picker row             | the Combobox option metrics        | `--spacing-control-x/y`, `--radius-control`; focused `--el-option-active-bg`; name `--el-text`, sub `--el-text-secondary` |
| a row's reason / link    | —                                  | `--el-text` · `--el-link`; inline command `--el-code-bg` / `--el-code-text`, `--radius-badge`                             |
| state pills              | `RunTonePill` + `AGENT_STATE_TONE` | unchanged                                                                                                                 |
| sign-in glyphs           | lucide, `aria-hidden`              | `--el-success` · `--el-warning` · `--el-text-secondary`                                                                   |
| the **In my agent** chip | the hosted lane chip               | `--el-chip-bg`, `--el-text-strong`, `--radius-badge`, `--spacing-chip-x/y`                                                |
| refusal notices          | the hosted `notice warn`           | `--el-warning-surface`, `--el-warning`, `--el-text-strong`                                                                |
| the machine-time figure  | the hosted `.hxFig`                | `--el-surface-soft`, `--el-border-soft`, `--radius-control`; label/unit `--el-text-secondary`, value `--el-text`          |
| everything else          | the hosted delta's own             | unchanged                                                                                                                 |

No `--color-*`, no raw radius or height; `--el-text-muted` and `--el-text-faint` are used nowhere.

### Every string, and the i18n key it lands under (`en`; `zh` twins with the build)

**`runs.agent.*` — MOTIR-7028:**

| Key                                                                                                                                    | String                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `door.run` · `door.starting`                                                                                                           | Run in my agent · Starting…                                                                                                                                                                                                                         |
| `picker.title` · `picker.lead`                                                                                                         | Run {key} in one of your agents · Choosing an agent starts the run. An agent that is asleep wakes first.                                                                                                                                            |
| `picker.label` · `picker.foot` · `picker.manage`                                                                                       | Your agents · Only your agents on {project} are listed. · Manage in My agents                                                                                                                                                                       |
| `picker.signin.signedIn` / `.signedOut` / `.unknown`                                                                                   | Signed in · Not signed in · Sign-in can't be checked                                                                                                                                                                                                |
| `picker.next.now` / `.wakes` / `.whenUp` / `.failed`                                                                                   | starts now · wakes first · starts when it's up · wakes first — it failed last time                                                                                                                                                                  |
| `picker.off.hibernating` / `.deleting`                                                                                                 | It's stopping. Choose it again once it's hibernated — it will wake for the run. · It's being deleted.                                                                                                                                               |
| `picker.off.runActive`                                                                                                                 | Already running <link>{key}</link>. One run at a time in an agent — wait for it, or cancel it there.                                                                                                                                                |
| `picker.off.signedOut`                                                                                                                 | Sign in first: open {name} and run {command} in its terminal. <link>Open {name}</link> (`{command}` is rendered from `myAgents.panel.signin.signedOut.*`'s `<cmd>` values)                                                                          |
| `picker.off.imageTooOld`                                                                                                               | Made from an older image that can't run work items. Moving it to the newer image — keeping its home and sign-in — is on its way; a new agent can run them now.                                                                                      |
| `picker.off.cannotRun`                                                                                                                 | {agent} can't run a work item on its own — it has no unattended mode Motir can start.                                                                                                                                                               |
| `empty.title` · `empty.body` · `empty.create`                                                                                          | You have no agent on {project} yet. · An agent is your own coding agent — Claude Code, Codex and others — on your own sign-in, in Motir's cloud. Make one for this project, sign it in, and this work item can run in it. · Create one in My agents |
| `notReady` · `notReadyBoth`                                                                                                            | Run in my agent is available once this work item is ready — it has {count, plural, …} open blockers. · Run in my agent and Run hosted are available once …                                                                                          |
| `refused.nothing`                                                                                                                      | Nothing was started and nothing was charged.                                                                                                                                                                                                        |
| `refused.{notSignedIn,wrongProject,notReady,runActive,imageTooOld,cannotRun,hibernating,deleting,notFound,permission}.title` / `.body` | the refusal table above                                                                                                                                                                                                                             |
| `refused.wakeTitle`                                                                                                                    | Not started — {name} couldn't wake. (body: `myAgents.refusal.<key>`, verbatim)                                                                                                                                                                      |
| `phaseDetail.waking` · `.starting` · `.running`                                                                                        | Waking {name} · Starting in {name} · {agent} · {name}                                                                                                                                                                                               |
| `lane` · `where.live` · `where.ended` · `where.watch` · `where.open`                                                                   | In my agent · Working in <b>{name}</b> · {agent} · Ran in <b>{name}</b> · {agent} · Watch it in My agents · Open {name}                                                                                                                             |
| `meta.agent` · `meta.codingAgent`                                                                                                      | Agent · Coding agent (Lane / Elapsed / Took reuse `runs.hosted.meta.*`)                                                                                                                                                                             |
| `cost.machineDetail`                                                                                                                   | {name}'s running time — charged with the agent, in credits. No tokens: {agent} runs on your own sign-in.                                                                                                                                            |
| `cost.stripMachine` · `cost.stripNoTokens`                                                                                             | {name}'s running time, charged with the agent · No tokens — {agent} runs on your own sign-in                                                                                                                                                        |
| `end.notStarted`                                                                                                                       | The run couldn't start in the agent.                                                                                                                                                                                                                |
| `modalTitle` · `logFooter`                                                                                                             | Run in my agent · A run in your agent always reports its output. · Deleted after 30 days.                                                                                                                                                           |
| `cancel.body`                                                                                                                          | The run's session in {name} stops and its credentials are revoked. Work it already pushed stays on the run's branch, and this work item stays where it is. {name} keeps running, and your own shells in it are untouched.                           |

Reused unchanged: `runs.hosted.phase.*`, `phaseChip`, `meta.lane/elapsed/took`, `end.*`, `prHeadline`,
`cancel.title/keep/confirm`, `cost.head/liveHint/stripLive/stripUpdating/machine/unit.*`,
`refused.notWritable.*`, `runs.runStatus.*`, `myAgents.state.*`, `myAgents.refusal.*`.

**`myAgents.panel.run.*` — MOTIR-7029:** see `design/my-agents/design-notes.md` § _The agent's live
run_.

The recorded reasons (`agent exited with code {n}`, `the agent stopped`, …) are the RECORD's strings,
written by MOTIR-7027 and rendered verbatim — never catalogue copy.

### Allocation — who builds each element

| Element                                                                                                                                                                                                 | Builds it                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| the control, the picker, every row face, the no-agent popover, the not-ready line                                                                                                                       | **MOTIR-7028**                                       |
| the refusal and wake-refusal notices, the re-read on refusal                                                                                                                                            | **MOTIR-7028**                                       |
| starting (row loading, **Starting…**, the waking / starting detail), the run section faces, the lane chip, the agent line, the meta row, the machine-time figure, the end faces, Cancel and its confirm | **MOTIR-7028**                                       |
| the run modal's header, strip, phase chip and log footer for `origin: instance`                                                                                                                         | **MOTIR-7028**                                       |
| `ContentSectionCard`'s header wrap (a shared component)                                                                                                                                                 | **MOTIR-7028** (⚑ not in its title — allocated here) |
| the agents read with each agent's state, profile label, recorded sign-in and, per row, why it cannot take the run (`code`, plus the active run's `id` + key)                                            | **MOTIR-7026**                                       |
| the refusal codes with `name`, the run's key and id, the not-ready reason in the 4xx body                                                                                                               | **MOTIR-7026**                                       |
| the DTO's `agentInstance { id, name, profile, profileLabel }`, `origin: 'instance'`                                                                                                                     | **MOTIR-7023**                                       |
| the recorded reason strings, and the Hibernate / Delete refusal carrying the run                                                                                                                        | **MOTIR-7027**                                       |
| the run session listed on attach, tagged with its run id                                                                                                                                                | **MOTIR-7025**                                       |
| the panel's run line, the session switch, the watch strip, Hibernate / Delete off, the ended faces, the narrow view                                                                                     | **MOTIR-7029**                                       |

**⚑ Flagged — no sibling owns these as written:**

1. **The panel's _Last run_ line** needs the agent's LATEST run whatever its status; decision §5 names
   only `findRunningByAgentInstance` (running runs). MOTIR-7029 must add a latest-run-by-agent read
   (or drop the _Last run_ line and show nothing after the end).
2. **The `timed_out` backstop reason string** is not fixed by the decision; MOTIR-7027 writes it and
   this design renders whatever it records.
3. **`/runs`' Agent column** for an instance run (today it prints the run's `agent`, the profile id).
   Not drawn and not in any sibling's scope; it will read `claude` until someone changes it.
4. **The My agents LIST row** does not show that an agent is running a work item. Deliberately not
   drawn: the panel is where a person watches it, and the list's state pill already reads Running.

### What these deltas do NOT draw

Run hosted and every hosted face (MOTIR-684, composed); the model picker; the panel's lifecycle,
sign-in and terminal states (MOTIR-6937, composed); the image update flow (MOTIR-6862); a _Continue
in my agent_ control (not decided, §_What this does NOT decide_); starting a run in anyone else's
agent (never).

## Revision 2 — Run and Send to my agent, and the agent that is already working (MOTIR-7022, 2026-09-30)

**Amends § _Run in my agent_ above** and its mock **`design/runs/run-section--agent.mock.html`**,
which is regenerated in place (the card's own unapproved delta — revision 1 was published as evidence
`cmuo158kl0024hwoiw3es2gky` and sent back, and was never a design of record). The My agents mock
`design/my-agents/my-agents--run.mock.html` is unchanged: it draws no door and says "hosted" nowhere.

### The reviewer's note (Request changes on revision 1), verbatim

> I don't see the design when the agent is already running a work item. And the design to choose run
> own agent and "run hosted" is not clear, it's confusing. My agent is also hosted. "Run hosted"
> should be renamed. The user won't care about the term "hosted", it should just be choose a model and
> a run button. And for "my agent", the term should be more like "Send to my agent"

### What changed, and why

1. **"Hosted" leaves every string this delta draws.** Both paths run in Motir's cloud, so "hosted" did
   not tell them apart. What a person cares about is **who does the work**, and every surface now says
   that instead: Motir with the model you picked, or one of your own agents.
2. **Two named choices, not three header controls (panel 0).** The doors leave `ContentSectionCard`'s
   `headerRight` and become a **start bar** at the top of the Run section's body, under the caption
   _Start this work item_, above the history. Two options side by side, each a quiet panel
   (`--el-surface-soft`, `--el-border-soft`, `--radius-card`, `--spacing-card-padding`) with a title,
   one lead line saying who works it, and its control:

   | Option               | Glyph            | Lead (`--el-text-secondary`)                                                     | Control                                                                                    |
   | -------------------- | ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
   | **Run**              | `Cloud`          | _Motir works it on a fresh machine, with the model you pick. Billed in credits._ | the shipped model picker (the combo) + **Run** / **Run again** — `Button` primary `sm`     |
   | **Send to my agent** | `SquareTerminal` | _One of your own agents works it, with its coding agent and your sign-in._       | **Send to my agent** — `Button` secondary `sm` + `ChevronDown`, opens the picker of agents |

   Run is the section's one primary button (the one-press default, as before). Below the section's
   width the two stack, Run first. Where Motir's own runs are off on a deployment (`hostedDoor` null),
   the bar shows Send to my agent alone, full width. The section header no longer carries a door; it
   carries **Cancel run** only while a run is live.

   **The `ContentSectionCard` header wrap that revision 1 allocated to MOTIR-7028 is withdrawn** — the
   header holds at most one control again, so the shared component does not change.

3. **The busy agent has its own panel (panel 2).** Decision §5 allows one running run per agent. Three
   faces:
   - **The picker row.** A busy agent is listed like every other agent, `aria-disabled`, name dropped
     to `--el-text-secondary`; its pill reads **Working** (the running tone). Under it, a
     `--el-tint-sky` line in `--el-text-strong`, links `--el-link`: _Working on **{key}** · {title}. It
     can take another work item once that run ends._ **Open that run**. `{key}` links to the work
     item; **Open that run** opens the run modal (`/runs?run=<id>`). This replaces revision 1's
     _Already running {key}_ reason line.
   - **Sent anyway.** A stale list, a second tab or two sends racing all reach the start, which answers
     `agent_instance_run_active` with that run's id and key (§4; §5 translates the loser of the
     unique-index race to the same refusal). The notice sits under the start bar, never in the
     timeline, because no run was opened: **Not sent — {name} is already working on {key}.** · _An
     agent works on one work item at a time, and {name} can take this one once that run ends._
     **Open {key}'s run** _to watch or cancel it, or send this to another agent. Nothing was started
     and nothing was charged._ The picker re-reads its list, so the row then shows its busy line.
   - **Every agent busy.** The picker still opens and lists them all as busy, each naming its work
     item, so the developer can see which run to wait for; **Run** stays one press away beside it.

4. **The refusal family is _Not sent —_** (was _Not started —_) for the agent path, because what
   failed is the send. Bodies are revision 1's, with "run" reworded to "work" where it named the
   action. The body ending _Nothing was started and nothing was charged._ is kept. The wake
   pass-through title is **Not sent — {name} couldn't wake.**, and its body is still
   `myAgents.refusal.*` word for word.
5. **The run Motir works is renamed in the section and the modal (panels 11, 12)**, so the two paths
   read alike:
   - The lane chip that read _Hosted_ shows the **model** (`Cloud` + `claude-opus-5-5`) beside
     _Motir is working on it_.
   - The meta row reads **Worked by** Motir · **Model** · **Elapsed**. There is no _Lane · Hosted_.
   - The modal title is **Run** `{KEY}` for BOTH paths.
   - The log footer is _This run always reports its output._ for both.
   - An agent run reads: chip `SquareTerminal` + _{name} · {coding agent}_, _Your agent is working on
     it_ + **Watch it in My agents** (ended: _Your agent worked on it_ + **Open {name}**), and meta
     **Worked by** {name} · **Coding agent** · **Elapsed**/**Took**.
   - Everything else about the run Motir works (phases, the cost block, ends, cancel) is MOTIR-684's,
     unchanged.

### The panels (revision 2)

0 the two ways to start: ready, narrow (stacked), and Send-only · 1 the picker · **2 the agent
already working on a work item: the busy row, sent anyway, every agent busy** · 3 every agent state
and every other row reason · 4 the start bar's other states: no agent, not ready, and a run already
live on the work item · 5 every send refusal · 6 the wake's refusals · 7 starting · 8 running and
succeeded in an agent · 9 failed, cancelled and timed out · 10 cancel · 11 the run Motir works,
renamed · 12 the run modal.

- **Not ready (panel 4):** both options disabled in place, and ONE line for both: _Run and Send to my
  agent are available once this work item is ready — it has {n} open blockers._
- **Starting (panel 7):** the pressed row shows the loading state; the option's button reads
  **Starting…**; Run is disabled. On the answer the start bar gives way, the header shows **Cancel
  run**, and the phases appear with Starting current: _Waking {name}_ or _Starting in {name}_.
- **After an end:** the start bar returns above the result, with **Run again** on Motir's side and
  **Send to my agent** on the agent side. The agent side never says "again", because the next run may
  be in another agent.

### Strings — what revision 2 changes (`en`; `zh` twins with the build)

**`runs.start.*` — new, MOTIR-7028** (the bar is shared by both paths):

| Key                        | String                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `caption`                  | Start this work item                                                                                                                        |
| `run.title` · `run.lead`   | Run · Motir works it on a fresh machine, with the model you pick. Billed in credits.                                                        |
| `send.title` · `send.lead` | Send to my agent · One of your own agents works it, with its coding agent and your sign-in.                                                 |
| `notReady`                 | Run and Send to my agent are available once this work item is ready — it has {count, plural, one {# open blocker} other {# open blockers}}. |

**`runs.agent.*` — changed from revision 1's table** (unlisted keys stand as written above):

| Key                                        | Revision 1                                                            | Revision 2                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `door.run` → **`door.send`**               | Run in my agent                                                       | Send to my agent                                                                                                                                                              |
| `picker.title` · `picker.lead`             | Run {key} in one of your agents · Choosing an agent starts the run. … | Send {key} to one of your agents · Choosing an agent sends it and starts the work. An agent that is asleep wakes first.                                                       |
| `picker.off.runActive` → **`picker.busy`** | Already running {key}. One run at a time in an agent — …              | Working on <link>{key}</link> · {title}. It can take another work item once that run ends. <run>Open that run</run>                                                           |
| `picker.busyPill`                          | —                                                                     | Working                                                                                                                                                                       |
| `empty.body`                               | … and this work item can run in it.                                   | … Make one for this project, sign it in, and you can send work items to it.                                                                                                   |
| `notReady` · `notReadyBoth`                | Run in my agent … · Run in my agent and Run hosted …                  | `notReady`: Send to my agent is available once this work item is ready — … (bar shows it alone). `notReadyBoth` is retired for `runs.start.notReady`.                         |
| `refused.*.title`                          | Not started — …                                                       | Not sent — … (e.g. _Not sent — yue-claude is already working on {key}._)                                                                                                      |
| `refused.runActive.body`                   | One run at a time in an agent. Wait for it to finish, …               | An agent works on one work item at a time, and {name} can take this one once that run ends. <run>Open {key}'s run</run> to watch or cancel it, or send this to another agent. |
| `refused.wakeTitle`                        | Not started — {name} couldn't wake.                                   | Not sent — {name} couldn't wake.                                                                                                                                              |
| `lane`                                     | In my agent                                                           | {name} · {agent} (the chip names the agent)                                                                                                                                   |
| `where.live` · `where.ended`               | Working in {name} · {agent} · Ran in {name} · {agent}                 | Your agent is working on it · Your agent worked on it                                                                                                                         |
| `meta.agent`                               | Agent                                                                 | Worked by                                                                                                                                                                     |
| `modalTitle` · `logFooter`                 | Run in my agent · A run in your agent always reports its output.      | retired — both paths use `runs.hosted.modalTitle` / `logFooter` as renamed below                                                                                              |

**`runs.hosted.*` — the shipped keys whose copy changes. MOTIR-7028 ships this rename** (the keys
keep their names; only the `en` / `zh` values change):

| Key                             | Shipped                                                                     | Revision 2                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `door.run` · `door.runAgain`    | Run hosted · Run hosted again                                               | Run · Run again                                                                                  |
| `picker.footer`                 | The models that can run a hosted work item. The run is billed …             | The models Motir can run this work item with. The run is billed to your organization in credits. |
| `picker.loadingBody`            | Loading the models that can run hosted…                                     | Loading the models Motir can run it with…                                                        |
| `picker.unavailableBody`        | Couldn't load the models that can run hosted, so Run hosted is off for now. | Couldn't load the models, so Run is off for now.                                                 |
| `picker.emptyBody`              | No model can run a hosted work item right now, so Run hosted is off. …      | No model can run this work item right now, so Run is off. Local runs are unaffected.             |
| `notReady`                      | Run hosted is available once …                                              | Run is available once … (the bar shows it alone); with both, `runs.start.notReady`               |
| `refused.outOfCredits.body`     | … Run hosted works again once the organization has credits.                 | … Run works again once the organization has credits.                                             |
| `refused.modelNotOffered.title` | {model} is no longer offered for hosted runs.                               | {model} is no longer offered.                                                                    |
| `refused.unavailable.title`     | Not started — hosted runs aren't available right now.                       | Not started — Run isn't available right now.                                                     |
| `refused.bootFailed.title`      | The hosted run couldn't start its machine.                                  | The run couldn't start its machine.                                                              |
| `meta.hosted`                   | Hosted                                                                      | Motir (read as **Worked by** Motir; the lane chip shows the model)                               |
| `modalTitle`                    | Hosted run                                                                  | Run                                                                                              |
| `logFooter`                     | A hosted run always reports its output. · Deleted after 30 days.            | This run always reports its output. · Deleted after 30 days.                                     |

`runs.agent.meta.worked` (new): **Worked by**, shared by both paths' meta rows.

### Allocation — changes to revision 1's table

- **MOTIR-7028** builds the start bar (`runs.start.*`), the busy row and busy refusal, the renamed agent
  copy, **and the `runs.hosted.*` rename above** (the shipped Run section, the run modal and the model
  picker).
- **MOTIR-7028 no longer changes `ContentSectionCard`** (the wrap is withdrawn).
- **MOTIR-7026's agents read** must carry, for a busy agent, the active run's `id`, its work item's
  key **and title** (the busy line names the title). The refusal body carries the id and the key, as
  before.

### ⚑ Flagged — "hosted" still on screen outside this delta (no sibling owns these)

The reviewer's point applies beyond the Run section, but these surfaces are not drawn here and no card
in MOTIR-6864 owns them. They are follow-ups for the planner:

- `github.development.fix.hosted.*` — _Fix on the hosted agent_
- `github.development.continue.hosted.*` and `continue.reason.stalled` / `.backstop` — _Continue
  hosted_
- `workbench.toFix.fixingHosted*`
- `repositoryPicker.hostedRuns.*`
- `approvalGate.agentReview.couldNotRun.reason.*`
- `issueViews.provenanceSourceHosted`
- `billing.ai.tagline` / `billing.plans.subtitle` — _hosted agents_

("Self-hosted" in install-mode copy is a different meaning and stays.)

## Waiting on you — a run's manual leg names who it waits on (MOTIR-7473, 2026-10-03)

**Asset:** `design/runs/run-section--waiting-on-you.mock.html`, a NEW delta mock. It amends
`run-section.mock.html` and § _The run MODAL_ / the runs index above; neither is edited. Card MOTIR-7473
(Story MOTIR-7460), built on `docs/decisions/manual-work-gate.md` §8; built by **MOTIR-7477**. **The
copy table (en + zh) and the GIVES/TAKES are in `design/workbench/design-notes.md` § 33.4**, beside the
gate's row and overlay; this section holds the runs area's rules.

- **The wire value and the disposition do not change.** A manual card a run reaches is still
  `skipped` / `skipReason: needs_human`, and still takes the `skipped` tone (muted chip, tertiary dot) —
  § _THE TONE VOCABULARY_ refuses a new tint for a distinction the words carry.
- **The LABEL is resolved per leg from that card's `manual_work` gate**, so `needs_human` maps to four
  strings: _Skipped — waiting on you._ (awaiting, routed to the READER) · _Skipped — waiting on {name}._
  (awaiting, routed to someone else) · _Skipped — marked done by {name}._ (approved) · _Skipped — manual
  work._ (no gate: withdrawn, a leg older than the kind, or a run that raised none). _Skipped — needs a
  human._ is retired. _You_ is the reader, not the run's starter (the CLI's report uses the starter, ADR §8).
- **Where it shows** (Panels 1, 3): the compact `RunTonePill` on the run modal's canvas node
  (`RunCanvasPane` → `WorkItemNode`) and the leg line in an item page's Run section (`RunSection`). The
  manual card's own page usually draws Guide me through in the Run section's slot (MOTIR-7467), so the
  leg line there is for a reader without that door.
- **The summary** (`legSummary`, Panel 2): waiting legs leave _skipped_ and become their own segments
  right after _done_ — _{n} waiting on you_, then _{n} waiting on others_ — each omitted at zero. A leg
  whose gate was marked done counts as skipped: the run did not do it.
- **zh** (Panel 4): 已跳过 — 等你处理。 · 已跳过 — 等 {name} 处理。 · 已跳过 — 已由 {name} 标记完成。 ·
  已跳过 — 人工工作。 · 等你处理 {n} 项 · 等他人处理 {n} 项.

## Stopped at a gate — a run that waits on an approval is not dead (MOTIR-7702, 2026-10-07)

**AMENDS** § _Run died_ above — Panel **R1** of `run-section--run-died.mock.html` (the run section's died line
and RUN pill) — in the delta **[`run-section--gated.mock.html`](./run-section--gated.mock.html)**, Panels
**G1–G6** and the zh panels, at desktop, dark (G1) and ~400px (G1, G6). **No existing mock is edited.** Card
MOTIR-7702 (Story MOTIR-7701); built by **MOTIR-7713**. The Workbench half — the **To resume** tab — is
`design/workbench/design-notes.md` **§ 35** and `workbench--to-resume.mock.html`; § 35.6 holds the shared copy
for the gate list, the gate states and the skip reasons, which this section reuses rather than re-keys.

**Why it is owed.** A parent run that stops because its remaining work waits on an approval closes `gated`
(MOTIR-7703), which maps to `succeeded` and is outside `DIED_STATUSES`. Without a marker of its own the run
section either says nothing (it looks finished) or — once read as not alive — _Run died_, which tells the reader
the run broke when it is simply waiting for them.

### The panels

| panel | state                                                                                                        | shown when (and the card that specifies it)                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| G1    | **Stopped at a gate** — the RUN pill, the line naming the held gate, the gate rows, the history row (hosted) | the section's run closed `gated` and every held gate is awaiting (MOTIR-7703 rows; MOTIR-7707 `waiting_on_gate`) |
| G1b   | the same for a **terminal** run, with the viewer as the decider; the line NAMES `motir continue <KEY>`       | origin is not hosted, so nothing resumes by itself (MOTIR-7710 `not_a_candidate`)                                |
| G2    | **Ready to resume** — several gates, one approved; the command is copyable                                   | a held gate approved / chosen / confirmed / marked done (MOTIR-7707 `ready_to_resume`; MOTIR-7708 `resumable`)   |
| G3    | **Resuming** — the auto-resume opened a run; the line links to it; the history shows both runs               | `GateResume.outcome = started` (MOTIR-7710); the continue run records it resumes a gated run (MOTIR-7708)        |
| G4    | **Could not resume** — the gate was approved, the auto-resume was refused; the reason in words               | `GateResume.outcome = skipped` + `skipReason` (MOTIR-7710)                                                       |
| G5    | **Gate sent back** — nothing resumes                                                                         | a held gate `changes_requested` / `declined` / `overturned` (MOTIR-7707; MOTIR-7708 refuses `gate_sent_back`)    |
| G6    | **A child card** of the gated parent run — points UP at the parent                                           | the card was a leg of a gated `run_scope` run (MOTIR-7703's scope)                                               |

### Decisions

| decision        | chosen                                                                                                                  | why                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| where it sits   | the Run died line's slot (`rd-run-line`), with the RUN pill beside the leg pill                                         | one slot for "what became of this run"; a gated run and a died run are never both the latest                                                                                     |
| the tone        | `pill-yellow` — the gate's own Awaiting tint (the overlay's _Awaiting you_) — glyph `circle-pause` in `--el-icon-muted` | _waiting_ is neither failed nor unknown: peach is the died/timed-out tone and must not be borrowed. No new hue: the tint is already the product's word for "awaiting a decision" |
| naming the gate | by kind and key in the line (_the design result on ACME-13_), then one row per held gate with _Open_                    | the reader's next question is _which approval_; the overlay (MOTIR-5222) is where it is decided                                                                                  |
| the command     | NAMED while waiting (non-hosted), COPYABLE once ready                                                                   | the claim refuses `gate_awaiting` until then (MOTIR-7708); a copy block for a refused command is a trap — § _Run died_'s own rule                                                |
| Resuming        | the section's current run becomes the continue (_Running_), and the line links to it                                    | the auto-resume opened a real run; the reader should be one click from watching it                                                                                               |
| a child card    | the D7 pointer grammar (`corner-left-up`), naming the parent                                                            | the gate is not on the child, and the parent is what resumes                                                                                                                     |
| a died run      | unchanged — MOTIR-6529's copy                                                                                           | the card's scope: a genuinely died run is still To fix's _Run died_                                                                                                              |

### Copy — `en` + `zh`

Namespace **`runs.gated`**, beside `runs.runDied`. Gate kind labels, gate states, deciders and skip reasons are
`workbench.toResume.*` (§ 35.6), shared.

| key               | en                                                                                                                                                                                              | zh                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pill`            | Stopped at a gate                                                                                                                                                                               | 停在审批处                                                                                                                 |
| `pillReady`       | Ready to resume                                                                                                                                                                                 | 可以继续                                                                                                                   |
| `gate`            | the {kind} on {key}                                                                                                                                                                             | {key} 的{kind}                                                                                                             |
| `waitingHosted`   | This run stopped at a gate — waiting on {gate}. Its work is kept on {branch}, and it carries on by itself on the hosted agent once the gate is approved.                                        | 此运行停在审批处——正在等待{gate}。其工作保留在分支 {branch} 上，审批通过后会在托管代理上自动继续。                         |
| `waitingLocal`    | This run stopped at a gate — waiting on {gate}. Its work is kept on its branch; once the gate is approved, continue it with {command}.                                                          | 此运行停在审批处——正在等待{gate}。其工作保留在分支上；审批通过后，用 {command} 继续。                                      |
| `waitingMany`     | waiting on {count} approvals (replaces _waiting on {gate}_)                                                                                                                                     | 等待 {count} 项审批                                                                                                        |
| `ready`           | Ready to resume — {approved} of {total} approvals given. Continue it to build what was approved; it stops again at any gate still waiting:                                                      | 可以继续——{total} 项审批中已通过 {approved} 项。继续即可构建已批准的工作；它会在仍在等待的审批处再次停下：                 |
| `resuming`        | Resuming — {name} approved {gate}, so a new run carries on on the same branch. <link>See the new run</link>                                                                                     | 正在继续——{name} 已批准{gate}，新的运行正在同一分支上继续。<link>查看新运行</link>                                         |
| `couldNot`        | {name} approved {gate}, but the run could not resume by itself: {reason}. Continue it from <link>To resume</link> on the Workbench, or with {command}.                                          | {name} 已批准{gate}，但运行未能自动继续：{reason}。请在工作台的<link>待继续</link>中继续，或使用 {command}。               |
| `sentBack`        | This run stopped at a gate — {gate} was sent back: changes requested by {name}. Nothing resumes until a new version is approved.                                                                | 此运行停在审批处——{gate}已被退回：{name} 要求修改。在新版本获批之前不会继续。                                              |
| `child`           | This work item was run as part of <link>{parent}</link>, and that run stopped at a gate — waiting on {gate}. It carries on from {parent} once the gate is approved, and this work item with it. | 此工作项的运行属于 <link>{parent}</link>，它停在审批处——正在等待{gate}。审批通过后会从 {parent} 继续，此工作项也随之推进。 |
| `history.resumed` | resumed after an approval                                                                                                                                                                       | 审批后继续                                                                                                                 |
| `history.partOf`  | part of {parent}                                                                                                                                                                                | 属于 {parent}                                                                                                              |
| `gatesLabel`      | Gates holding this run                                                                                                                                                                          | 使此运行停下的审批                                                                                                         |

`{branch}` and `{command}` are set in the mono face (`rd-branch`); `{reason}` is § 35.6's skip-reason words.

### Tone and tokens

`--el-*` colour and element-semantic shape tokens only; the `rg-` block quotes no raw hue. The RUN pill:
`pill-yellow` (`--el-tint-yellow` + `--el-text-strong`) for _Stopped at a gate_, `pill-mint` for _Ready to
resume_, `pill-sky` for the resumed run's _Running_. The line keeps `rd-run-line`'s ink (`--el-text-secondary`,
names in `--el-text`); only its glyph moves from the died line's `--el-warning` to `--el-icon-muted`. Gate rows:
kind chip `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`, `--radius-badge`; key `--el-text-secondary`
mono; decider `--el-text-secondary`; _Open_ `--el-link`. Two sprites are added, extracted from
`lucide-react@1.16.0` with provenance comments: `circle-pause` (`#i-pause`) and `undo-2` (`#i-undo`).

### GIVES / TAKES

| key        | GIVES / TAKES                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-7713 | **GIVES** every panel (G1–G6), the copy and the tokens above. **TAKES** the held-gate rows (MOTIR-7703), the resume record (MOTIR-7710), the resumed mark (MOTIR-7708) |
| MOTIR-7703 | **TAKES** that a gated close names its gates — G1's line and rows read them                                                                                            |
| MOTIR-7708 | **TAKES** that a continue opened on a gated run records it resumes one — G3's history row reads it                                                                     |
| MOTIR-6529 | **GIVES** nothing new; its Run died line and pill are unchanged for a run that really died                                                                             |
| MOTIR-7702 | this card                                                                                                                                                              |

## Fix in my agent — the third door in the fix part (MOTIR-9043, 2026-10-19)

**Design system.** Read `package.json` (depends on `@motir/design-system`, installed 0.15.1) and
`app/globals.css` (imports `@motir/design-system/theme.css`): **both checks hold, so this is on Motir
Design.** The project's own axes come from `app/layout.tsx` (`data-style`, `data-palette`, `data-type`,
applied per viewer). The package exports `@motir/design-system/mock`, and this sheet does not use it:
the fix part, the run modal's header and the settings row are product-local components, so, like every
sibling sheet in this area, it composes their shipped markup with `theme.css` inlined (the stylesheet
is `development--continue-hosted.mock.html`'s, verbatim). **No part is proposed for the package**; the
three product-local pieces it draws are `RepairFixPart`, the run modal's header action and the
auto-fix settings row, each composed from `Button`, `Switch`, the settings card and `Notice`.

**AMENDS** `design/github/design-notes.md` § 21 (Panels F1–F4) and § 30 (Panels 3–3e) — the fix part of
the Development block — and `design/runs/run-modal.mock.html`'s header, in the delta
**[`development--fix-in-my-agent.mock.html`](./development--fix-in-my-agent.mock.html)**. **No existing
mock is edited** and no image export ships (`docs/decisions/design-result.md` AMENDMENT 4). Subtask
MOTIR-9043, story MOTIR-8981. It gates MOTIR-9053 (the door), MOTIR-9047 (the copy), MOTIR-9060 (the switch and its
row), MOTIR-9054 (the automatic start, which draws nothing) and MOTIR-9056 (the acceptance
recording); the Chinese twins are the translate work items'.

**Why it is owed.** A run in the person's own agent that ended with an open, red pull request leaves
two doors in the fix part: a command to copy and, on a work item a review sent back, a fix on the
_hosted_ agent. Neither hands the pull request back to the agent that already knows the build. This
adds that third door, the same action in the ended run's modal, and the project switch that lets
Motir press it when the webhook reports the delivery set red.

**Access path.** Three, all existing places: the **fix part** in the item page's Development block;
the **header of an ended run** in the run modal; and the **Hosted agent room**
(`/settings/project/hosted-agent`) for the switch. No new route, no new rail entry.

### The state → producer table

Every state is drawn and names the field or read that produces it. A state no producer computes is
withheld (last two rows) and not drawn under "the nearest computable answer".

| Panel | State                              | What the fix part draws                                                                               | What produces it                                                                                                          |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A1    | Not offered — no pull request      | nothing new; the block's empty state stands alone                                                     | linked rows and delivery set both empty — `hasOpenPullRequest` false and no delivery row (`DevelopmentSection.tsx`)       |
| A2    | Not offered — not red              | nothing; the rows' own state stands                                                                   | the delivery rows' CI state — the `not_failing` / `ci_running` half of the repair claim's evaluation                      |
| A3    | Not offered — no agent to use      | the copyable `motir fix <KEY>` (and the hosted door where passed), exactly as shipped; no door        | the last in-agent run names no profile, or the viewer's agent probe refuses                                               |
| B1/B2 | **Offered**                        | the door, one supporting line naming the agent and **resume** or **fresh**                            | red delivery + no claimed repair + a usable agent; the resume form from the profile table (`RESUMABLE_AGENT_PROFILE_IDS`) |
| C     | **Preparing**                      | the door busy (`Button` `loading`), the agent and the command still visible                           | the press, before the fix run has a row                                                                                   |
| D     | **In progress**                    | which agent, since when, the way into the run's modal. **No door and no command**                     | the repair view non-null with a live `fix` run (`WorkItemRepairViewDto`)                                                  |
| E     | **Refused**                        | the door, its answer directly under it (a `Notice`)                                                   | the claim's result at the press: `taken`, the holder named with the start                                                 |
| F     | Settled out from under it          | the part withdraws, no error; the rows' green state takes the space                                   | the delivery going green while preparing — the read that stopped offering it                                              |
| G     | **Fell back to a fresh session**   | a notice in the in-progress face naming the agent                                                     | the fix run's recorded start mode (resumed or fresh), written by the run that started it                                  |
| H     | **Gave up**                        | the shipped gave-up face, then the door back in its offered face                                      | the repair view's gave-up face after `CI_FIX_ATTEMPTS` (5, `packages/cli/src/ciWatch.ts`)                                 |
| M1–M6 | The ended run's modal header       | the same faces, offered · preparing · in progress · refused · fell back · gave up, in the header      | the same producers as B–H, for the one work item of that run that qualifies                                               |
| S1–S3 | Setting row — off · on · read-only | title, one line, the switch; off is the default and says nothing starts when the agent cannot be used | the project's stored setting; read-only is a reader with `work_item:edit` and not `ai:configure` (`canConfigure`)         |
| S4–S5 | Setting row — committing · failed  | the switch in flight; on failure it is put back and a toast names the failure                         | the write and its error — `ReviewAgentCard`'s optimistic pattern                                                          |
| —     | Withheld — no `work_item:edit`     | nothing drawn                                                                                         | the room's own no-access state (`guardSettingsPage('hosted-agent', ctx)`)                                                 |
| —     | Withheld — no hosted-runs build    | nothing drawn                                                                                         | the page returns `notFound()` without `isHostedRunsAvailable()`                                                           |

### Placement rule

The door goes **inside the fix part**, between the failing line and the hosted door, and the copyable
command stays last as the quietest path. A second part in the same slot would draw the in-progress and
gave-up faces twice. The part stays a **flush part, not a box**: a soft rule and an `h4`. When the
hosted door is also passed (a work item a review sent back), the order is **Fix in my agent**, then
**Fix on the hosted agent**, then the command, each with its own lead; a plain red work item draws the
door and the command. There is **no agent picker**: the door acts in the agent the last in-agent run
used and names it on its supporting line.

In the run modal the action sits in the **header**, under the title block, and only where **exactly
one** work item of that run qualifies. With none or several red deliveries the header draws nothing and
each work item's Development block is the door — naming one arbitrarily would start a fix on the wrong
pull request. The canvas, the log pane and the load / missing / failed states are not redrawn.

### The server-side offeredness rule

The browser never guesses. The part is offered when `workItemRepairService.getRepairView` (the repair
claim's own evaluation) says the claim would answer `claimed` for a red delivery **and** the last
in-agent run's resume target (`agentInstanceRunService.resumeTargetForCard`, the `resume-target` read)
names a profile the viewer may use. The profile table decides the supporting line: a profile with a
resume form draws **resumes the session it recorded**, one without (`aider`) draws **starts a fresh
session on the same branch**. A press that loses a race is a RESULT, drawn under the door (E); a delivery
that turns green mid-press withdraws the part (F).

### The copy seam

Every rendered string is a **slot**; the legend at the top of the sheet lists each slot's name and the
length the layout reserves, and each element carries `data-slot` / `data-len`. The copy work item's
words replace the mock's provisional labels without changing a panel. The supporting line wraps and is
never truncated at the Development block's narrowest width (B1, ~400px). The noun is **work item**
throughout; the sheet has no rendered use of the other noun.

### The setting row's room

`/settings/project/hosted-agent`, below the model-by-difficulty settings, in the room's own column (the
sheet sets no width). Keys: `work_item:edit` to see the room, `ai:configure` to flip the switch. Read-only
(S3) is the room's Panel 5 banner and the switch disabled at the stored value. The switch commits at once
and is put back on failure with the room's toast (S4, S5). The row's storage and API are the auto-fix
switch work item's; the webhook path that reads it is the setting-gated work item's.

### Every member of the claim's unions

| Member                                    | Face                                                        | Reaches this door?                                                              |
| ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `claimed`                                 | In progress (D)                                             | yes — the press succeeded                                                       |
| `mine`                                    | In progress (D) — the viewer's own open `fix` run, no error | yes — a second press by the same person                                         |
| `taken`                                   | Refused (E), once                                           | yes — somebody else's open `fix` run                                            |
| `not_repairable` · `not_implemented`      | the part withdraws (A-faces)                                | a race only: the work item left Implemented / In Review between offer and press |
| `not_repairable` · `repair_on_run_target` | the shipped child pointer ("Run the fix from <key>")        | **no** — the door is never offered on a child; the shipped pointer face stands  |
| `not_repairable` · `no_pull_requests`     | A1                                                          | a race only: the last pull request was unlinked                                 |
| `not_repairable` · `ci_running`           | the part withdraws (F)                                      | a race only: a push restarted the checks                                        |
| `not_repairable` · `not_failing`          | the part withdraws (F)                                      | a race only: the delivery went green                                            |
| `not_repairable` · `repair_not_code`      | the shipped face names what would help instead              | **no** — no code change fixes it, so the door is never offered                  |

### Withheld, and the producer each is missing

- **The reader without `work_item:edit`** meets the Hosted agent room's shipped no-access state; the row has no
  rendering of its own.
- **A build without hosted runs** has no room (`notFound()`), so no row and no panel.
- **A refusal panel per reason** beyond `taken`: the table above gives each member's face; a panel per
  reason would invent states nothing produces.
- **The transcript line saying the session was resumed** is the CLI's own output through the shipped log
  pane and is not drawn here.

### Tone and tokens

`--el-*` colour and element-semantic shape tokens only; the `fm-` block quotes no raw hue. The door is
`Button` primary small with the `terminal` glyph; busy is its `loading` spinner. Notices are
`HostedDoorNotices`' warning surface (`cc-notice`); fell-back uses the `info` glyph on the same surface
because nothing failed. Three sprites are added, extracted from `lucide-react` with provenance comments:
`lock`, `info`, and the settings row reuses `terminal`.

### GIVES / TAKES

| key        | GIVES / TAKES                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-9043 | **GIVES** every panel above, the slot legend and the table. **TAKES** nothing.                                                     |
| MOTIR-9053 | **TAKES** A–H and M1–M6, the offeredness rule and the placement rule — the door in the Development block and the ended run's modal |
| MOTIR-9047 | **TAKES** the slot legend and the copy seam: one string per slot, within the reserved length                                       |
| MOTIR-9060 | **TAKES** S1–S5 and the room's two keys — the stored switch and its row                                                            |
| MOTIR-9054 | **TAKES** that the row is off by default and that a not-usable agent means nothing starts; it draws nothing itself                 |
| MOTIR-9056 | **TAKES** the states a person meets on the way: B1, C, D and the red-to-green settle (F)                                           |

## Run hosted — a model with no agent-run capacity (2026-10-26)

**Design system.** Read `package.json` (depends on `@motir/design-system`, `workspace:*`, installed
0.17.1 per `packages/design-system/package.json`) and `app/globals.css` (imports
`@motir/design-system/theme.css`): **both checks hold, so this is on Motir Design.** The project's own
axes come from `app/layout.tsx` (`data-style`, `data-palette`, `data-type`, applied per viewer). The
package exports `@motir/design-system/mock`, and this sheet does not use it: the start bar, the door and
its notices are product-local components, so, like every sibling sheet in this area, it composes their
shipped markup with `theme.css` inlined (the token, chrome and primitive layers are
`run-section--from-difficulty.mock.html`'s, verbatim). **No part is proposed for the package**: the held
option is the shipped `Combobox` `disabled` option, the tag is the shipped `Pill`, and the notices are
the door's shipped `Notice` (`HostedDoorNotices.tsx`). The product-local pieces drawn are `StartBar`'s
`StartOption`, `RunDoorControl`, `HostedModelPicker`, `HostedModelProvenance`, `HostedDoorNotices` /
`RefusalNotice`, and the Continue and Fix hosted doors (`ContinueHostedControl`, `FixHostedControl`).

**AMENDS** § _Run hosted — the picker says where its model came from_ above (Panels F1–F6,
[`run-section--from-difficulty.mock.html`](./run-section--from-difficulty.mock.html)) and, in the
published Run hosted design result (`run-section--hosted.mock.html` and its notes), **§ The model
picker** and **§ Refusals live on the DOOR** (the model-refused state). The change is drawn in the delta
**[`run-section--no-capacity.mock.html`](./run-section--no-capacity.mock.html)**. **No existing mock is
edited**, and no image export ships (`docs/decisions/design-result.md` AMENDMENT 4).

### What changes

Every offered model carries an agent-run capacity verdict, `available` or `no_capacity` plus a reason
code, on the models read the picker already makes, so there is **no separate loading face for
capacity**. A `no_capacity` model stays in the menu, is labelled, and cannot be picked; a selected one
holds the door's start button; a launch refused for that reason answers with a sibling of the shipped
refusals. Planning surfaces are never labelled.

### Panels

| panel      | state                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| N1 · N1-zh | Open menu, mixed: `claude-opus-5-5` with _Default · anthropic_, `claude-opus-5` ticked with the difficulty description, `claude-fable-5-1` held |
| N2         | Keyboard focus resting on the held option: the active row, announced unavailable; Enter and click do nothing                                    |
| N3 · N3-zh | The selected (difficulty-resolved) model is held: trigger, provenance line, Run disabled, Held Run line                                         |
| N4         | The label clearing while the menu is open: before (held) and after (available), side by side, in place                                          |
| N5 · N5-zh | Every model held: the menu, Run disabled, the All-models-held line                                                                              |
| N6 · N6-zh | Run refused for no capacity: the No-capacity refusal under the start bar, the picker refreshed to held                                          |
| N7         | The Continue hosted door: held (button disabled, Held Run line) and refused                                                                     |
| N8         | The Fix hosted door: held and refused                                                                                                           |
| N9         | Fail-open: the capacity read failed, is unconfigured or is degraded — identical to today's picker                                               |

The access path is the shipped one: the start bar at the top of the work item's Run section (Run), and
the Development block's hosted Continue and Fix doors. Nothing new opens anything.

### The elements, named once

- **Held model option** — the shipped `Combobox` option with `disabled: true`. It stays **focusable**
  and is announced `aria-disabled`; its label reads in `--el-text-secondary` with **no opacity dim**
  (the Combobox's own rule, which keeps AA); `cursor-default`; a click or Enter on it does nothing and
  the menu stays open. Its `secondary` text (the provider, or _Default · provider_) is **dropped while it
  is held** and the tag takes its slot. Why: the menu is `max-w-[18rem]`, and a model id, _Default ·
  anthropic_ and a tag cannot share a row without truncating the id, which is the one thing a person
  must read; and _Default_ / the provider are facts for choosing a model, which a held model cannot be.
  Both come back the moment the label clears. If the held option is also the difficulty-resolved one,
  the **Capacity reason line takes its `description` slot** and the provenance stays on the door's
  `HostedModelProvenance` line under the trigger, which is still true.
- **No-capacity tag** — `Pill severity="warning"` in the option's `trailing` (pinned right, `ml-auto`
  since there is no `secondary` before it). Warning, not neutral: the state is temporary and
  actionable, and the peach tint is the same family as the door's warning `Notice`, so the tag and the
  refusal read as one thing.
- **Capacity reason line** — the option's `description` (menu row only, never the trigger), text-xs,
  `--el-text-secondary`.
- **Held Run line** — a `<p>` that is the last, full-width child of the door row, after the
  `HostedModelProvenance` line (`basis-full`, text-xs, `--el-text-secondary`, the model id in
  `font-mono font-semibold --el-text`). It is the start button's `aria-describedby`. It is worded
  without naming a button, so the same string serves Run, Continue and Fix.
- **All-models-held line** — the door's shipped `Notice` in `HostedDoorNotices`, the slot the empty
  face's line (`picker.emptyBody`) uses. When it shows, the door's Held Run line is **not** drawn, so the
  state is said once.
- **No-capacity refusal** — a new `RefusalNotice` reason, `noCapacity`, beside `modelNotOffered`: the
  same `Notice`, a semibold title naming the model and a body. It is reached from Run, Continue and Fix
  (each renders it through its own refusal renderer, reading `runs.hosted.refused.noCapacity.*` as they
  read `modelNotOffered.*` today). As with _is no longer offered_, the answer **refreshes the picker in
  place**, so the option then reads held and the button is off; while the refusal stands the door's Held
  Run line is **not** drawn, so the model is named once. Picking another model clears the refusal. A
  hosted review has no door of its own; its gate's could-not-run line is worded from this refusal's
  title sentence.

### The preselect decision — the model STAYS, and Run is held

When the preselected default, the difficulty-resolved model or the person's own pick is `no_capacity`
— when the door opens or while it is open — **the selection does not move**. The trigger keeps the
model, the start button is disabled, and the Held Run line says why and what to do (Panel N3).

**Why.** The preselection is the project's per-difficulty choice (its Hosted agent settings), and the
model is what the run is billed on and built with. Silently moving it to "the first available model"
would start a run on a model nobody picked, possibly a cheaper or weaker one, and the provenance line
(_From difficulty: High_) would then be describing a model that is not in the trigger. And a person's
own pick must never change under them while the menu is open. One rule for all three sources is also
the only rule a person can predict. The cost is one extra choice when they are in a hurry, which the
line invites in so many words, and the hold lifts by itself when capacity returns (Panel N4).

The trigger is the shipped trigger: label alone while held, because the held option has no `secondary`
and the trigger never draws `trailing`. The Held Run line carries the state.

### The label clearing in place

The verdict is re-read while the door is open. When capacity returns the row changes **in place**: the
tag goes, `aria-disabled` goes, the reason line gives its slot back (to the difficulty line, if that
option is the resolved one), the `secondary` returns, the Held Run line goes and the button turns on.
**No spinner, no skeleton and no dim**, the menu neither closes nor moves its active row, and focus stays
where it was. The refresh is silent, so the shell's navigation-pending grammar does not apply. Losing
capacity while open is the same swap the other way.

### Fail-open is the unchanged face

When the capacity read fails, is not configured or is degraded, every model reads `available`, and the
picker is **identical to today's** (Panel N9). There is **no "unknown capacity" state** — nothing to
build. A launch is still checked at start; the No-capacity refusal (N6) is what a person meets if it is
refused.

### Tokens

| element              | colour                                                                     | shape                                                                     |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Held model option    | label `--el-text-secondary`; active row `--el-option-active-bg`            | `--radius-control`, `--spacing-control-x/y` (the Combobox row)            |
| No-capacity tag      | `Pill severity="warning"`: `--el-tint-peach` fill, `--el-text-strong` ink  | `--radius-badge`, `--spacing-chip-x/y`                                    |
| Capacity reason line | `--el-text-secondary`                                                      | the Combobox `description` (text-xs, `max-w-[18rem]`)                     |
| Held Run line        | `--el-text-secondary`; model id `--el-text`                                | layout only (`basis-full`, `-mt-1`, `px-0.5`, as `HostedModelProvenance`) |
| All-models-held line | `Notice`: `--el-warning-surface`, `--el-text-strong`, glyph `--el-warning` | `--radius-control`, `--spacing-control-x/y`                               |
| No-capacity refusal  | `Notice`, as above                                                         | as above                                                                  |
| start button, held   | `Button` primary sm, `disabled` (its shipped disabled look)                | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm`                   |

Every ink inside the start bar's option panel (`--el-surface-soft`) is `--el-text` or
`--el-text-secondary`; `--el-text-muted` and `--el-text-faint` carry no text on this sheet. One sprite
is added, `triangle-alert` (the `Notice` glyph), and `square-terminal` for the Send to my agent option.

### Copy

No string carries a number, a limit, a share, a counter or tenant wording, and the product noun is
**work item**. `{model}` is the model id, never translated.

| suggested key                          | en                                                                                              | zh                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `runs.hosted.picker.noCapacityTag`     | No capacity                                                                                     | 暂无容量                                                              |
| `runs.hosted.picker.noCapacityReason`  | No agent-run capacity right now. Try again shortly.                                             | 目前没有智能体运行容量，请稍后再试。                                  |
| `runs.hosted.door.heldModel`           | `<b>{model}</b>` has no agent-run capacity right now. Pick another model, or wait until it has. | `<b>{model}</b>` 目前没有智能体运行容量。请选择其他模型，或等它恢复。 |
| `runs.hosted.picker.allHeldBody`       | No model has agent-run capacity right now. Try again shortly; local runs are unaffected.        | 目前没有模型有智能体运行容量。请稍后再试；本地运行不受影响。          |
| `runs.hosted.refused.noCapacity.title` | Not started — {model} has no agent-run capacity right now.                                      | 未启动——{model} 目前没有智能体运行容量。                              |
| `runs.hosted.refused.noCapacity.body`  | Nothing was booted and nothing was charged. Pick another model, or try again shortly.           | 没有启动任何机器，也没有产生任何费用。请选择其他模型，或稍后再试。    |

One reason sentence covers both causes behind `no_capacity` (the agent share is full, or the provider is
answering with rate limits now): the person's remedy is the same and the copy shows no numbers, so the
reason code does not need a second sentence.

### Not drawn

- A loading or "unknown capacity" face: the verdict rides the existing models read, and fail-open is
  today's face.
- The Continue and Fix doors' open menu: it is the shared picker, so Panel N1 is theirs.
- The review gate's could-not-run line, To resume and automatic re-run lines: worded from the refusal
  title above by the work that owns those surfaces.
- The platform-admin capacity screen and any planning surface.
