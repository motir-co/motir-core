# Migrate-onboarding wizard — design notes (`design/onboarding-migrate/`)

**Subtask:** MOTIR-930 · 7.15.1 (`type: design`) · **Story:** MOTIR-815 (Migrate-existing-codebase
onboarding, Workflow B) · **Epic 7 · AI Planning Layer.**

The **wizard** for onboarding an EXISTING codebase into Motir. **Required core = Connect + Index** (link
the repos, Motir reads the code + silently derives per-repo conventions + a code-health check, auto-used,
nothing to approve). Everything after — **optional**: import your existing backlog, then plan in the
**existing universal plan screen** (`PlanningWorkspace`, MOTIR-1193/1299 — already built, NOT designed
here; the wizard just opens it after import). It is the layout source of truth for the wizard UI code
subtask **7.15.5 / MOTIR-934** and the orchestration wiring **7.15.2 / MOTIR-931** (both `blocked_by`
this card), and for the state-machine scaffolding **7.15.2a / MOTIR-1499**.

> **⭐ Scope — this card designs the ORCHESTRATION SHELL + the INDEX step; it COMPOSES the rest.** The
> wizard is a stepped frame that embeds surfaces four other Stories already designed. Per `notes.html`
> mistake **#82** (a design that composes an already-designed sub-surface must GROUND in that
> sub-surface's shipped asset and say so — or it gets built twice) and **#31** (the multi-panel /
> design-reference rule), this doc **cites** each embedded surface's owner and reproduces its language;
> it does **not** re-design connect / import / the plan screen. The genuinely new pixels here are (a) the
> **set-up wizard chrome + rail** (Connect · Index required · Import optional) and (b) the **index-progress
> step** (§Panel 2). ~~(c) **THE LANDING** (§Panel 0)~~ — **REMOVED 2026-09-06 (MOTIR-4766, Yue):** what
> the wizard opens at the end is the **regular planning session**, which arrives with the context and
> **waits to be told what to plan**. Nothing about it is migrate-specific, so this asset draws none of it;
> see §Panel 0. Product truths this revision bakes
> in (Yue, 2026-07): the **required core is just Connect + Index**;
> **conventions + code-health are derived SILENTLY, auto-used, with NO approval and NOT surfaced in
> onboarding** — they live on the Code-health page (§The spine, and the removed-Panel-3 §); conventions
> are **PER REPO** (§Multi-repo); **import + planning are OPTIONAL**; and the **optional import step
> composes `design/import`** (§Panel 3), embedded not redrawn.

**Asset files (three, shared basename):** `design-notes.md` (this file) ·
`onboarding-migrate.mock.html` (source of truth, standalone — re-states the real
`packages/design-system/theme.css` Tier-0 `--color-*` + shape scale, the Tier-3 `--el-*` layer, and
the `[data-theme='dark']` overrides 1:1 so it paints without the Tailwind build, exactly as
`design/coding-convention/convention.mock.html` does) · `onboarding-migrate.png` (full-page export,
light theme, Playwright chromium, `deviceScaleFactor: 1` (dropped from 2 only to keep the pack
pushable over a slow link — re-render at 2 when connectivity is healthy), 1200px wide). Dark parity was
verified by
toggling `data-theme="dark"` in the mock header.

---

## Designed against SHIPPED REALITY (design-against-shipped-reality)

Read the real surfaces this wizard lands in / replaces before drawing — the mock fits and extends the
implemented app, it does not invent a host:

- **`app/(onboarding)/onboarding/migrate/page.tsx`** — the wizard's **OWN route**, and its host.
  > **⚠️ Route amended 2026-07-27 (MOTIR-1710).** This section originally named the provisional
  > `/onboarding/import` hand-off placeholder (7.22.4 / MOTIR-1462) as the host, which "this wizard
  > replaces IN PLACE." That is **no longer true**: `/onboarding/import` is now the shipped **issue
  > importer** (7.16.6 / MOTIR-942 — `ImportWizard`, Connect → Map → Preview → Run), so the migrate
  > wizard took a route of its own. Verified on `origin/main` (rung 2): the wizard ships at
  > `app/(onboarding)/onboarding/migrate/page.tsx` + `_components/MigrateWizard.tsx` (7.15.5 /
  > MOTIR-934), and `app/(onboarding)/onboarding/import/` holds the importer. Everything else this
  > section specifies about the host still holds — only the route changed. (The importer is not
  > displaced by this: the wizard **composes** it as the optional Import step, §Panel 3.)
- **`app/(onboarding)/layout.tsx`** — the onboarding route group renders **OUTSIDE** the `(authed)`
  `AppLayout` (no top nav, no project sidebar) but is still **authenticated** (bounces a signed-out
  visitor to `/sign-in`). So the wizard **owns the whole viewport** with only a minimal brand bar —
  matched exactly, mirroring `design/onboarding-entrance`. (Onboarding is the one full-page first-run
  _route_, not the dismissable planning overlay — per `design/ai-chat`.)
- **`components/onboarding/OnboardingEntrance.tsx`** — the inbound door: the entrance's secondary
  import row (the `GitBranch` "I have an existing project — import it" button) → **`/onboarding/migrate`**
  (verified on `origin/main`; amended with the route above — MOTIR-1710).
  The wizard's brand bar continues the entrance's exact chrome (the `Sparkles` logo tile on
  `--el-tint-lavender`, the signed-in avatar).
- No wizard / stepper primitive ships in `components/ui/` — the **step rail is a NEW ARRANGEMENT** of
  shipped primitives (the same way `design/ai-chat`'s canvas roadmap and `design/coding-convention`'s
  onboarding step-strip are new arrangements). The precedent for a wizard step-strip is
  `design/coding-convention` Panel 5 ("Discovery ✓ → Design system ✓ → **Establish convention**
  (current) → Review plan") — this rail generalises it to the migrate steps (Connect · Index + the optional tier).

---

## ⭐ Multi-repo + multi-provider — a project spans several repositories, on GitHub OR GitLab (Yue)

**A real existing codebase usually spans more than one repository** (a web app + an API + a shared
package) — **and those repos can live on GitHub OR GitLab** (a project may span both, Yue 2026-07-09).
The first draft collapsed the flow to a single GitHub repo (`acme/web@a1b9f30`, one code graph, one plan);
this is corrected so the WHOLE wizard is **multi-repo and multi-provider**. Grounded in **shipped reality**
(rung 2 — read on disk this session, not assumed):

- **Multi-provider is ARCHITECTED, not invented — the `GitProvider` seam (`lib/git`, MOTIR-891 / 7.10).**
  Both `GithubInstallation` and `GithubRepo` carry a **`provider` discriminator** (`@default("github")`),
  and the schema comment is explicit: _"every downstream read goes through the GitProvider seam (`lib/git`),
  so GitLab/Bitbucket is purely additive (MOTIR-1470 implements the same seam under `provider: 'gitlab'`)."_
  `lib/git/` ships `provider.ts` (the ONE `GitProvider` interface), `registry.ts` (dispatch by the stored
  discriminator), and `providers/github.ts` (the first impl). So the Connect step offers **GitHub App +
  GitLab OAuth**, persists each repo with its `provider`, and every consumer (index, audit, plan) reads a
  provider-agnostic `NormalizedRepo` through the seam. **The GitLab provider itself (connect / OAuth /
  fetch / webhook) is Story MOTIR-1470 "GitLab integration"** (To Do) — this design draws the
  multi-provider Connect surface + flags MOTIR-1470 as the runtime dependency; it does NOT build the GitLab
  client. **GitHub is the day-one connect path; the GitLab affordance is feature-gated until MOTIR-1470
  ships** (so the wizard never renders a dead "Connect GitLab" button — build note on MOTIR-934, modeled
  `relates_to` not `blocked_by` so GitHub isn't delayed). Each Connect repo-row + the landing done-card are
  **provider-tagged**.
- **`GithubInstallation` is WORKSPACE-scoped and owns many `GithubRepo`s** (`prisma/schema.prisma`:
  `GithubInstallation { workspaceId } → repos GithubRepo[]`). Repo selection is a set, per workspace —
  a project is not "one repo."
- **The code graph is PROJECT-scoped and aggregates repos.**
  `lib/services/codeGraphIndexService.ts` → `indexRepoIntoWorkspaceProjects` fetches each repo's tarball
  and indexes it **into each of the workspace's projects' code-graph stores** ("A repo installed at a
  workspace is therefore indexed into each of that workspace's projects' code-graph stores"). So a
  project's code graph is **built from multiple repos**; the audit and the plan read that whole-project
  graph. (The service's own comment flags that a _precise_ repo↔project association — so a repo only
  indexes into the projects it belongs to — is a **future refinement, deliberately not built yet**; the
  wizard's per-project repo selection is exactly where that association gets captured.)
- **The coding convention is PER REPO — one standard per repository, NOT one per project (Yue,
  2026-07-05).** A legacy API and a modern web app in the same company rarely share a coding standard, so
  Motir derives a convention **per repository** (acme/web · acme/api · acme/shared, each its own grade).
  Each repo's convention is the standard Motir injects when it generates work **for that repo**.
  **⚠️ Two 7.14 corrections (see the removed-Panel-3 §): (i) per-repo, not one per project; (ii) derived +
  auto-used, NO approval, view/chat on the Code-health page — not an onboarding step.** On the 7.14 side,
  per-repo means scoping `CodingConvention` + `CodeAudit` to a `(project, repo)` pair (the audit already
  carries a `codeGraphRef`), and no-gate means dropping the approve + free-edit from the shipped MOTIR-926
  UI. The migrate wizard only **CONSUMES** the derived conventions (they never surface here), so it flags
  the model change rather than owning it.

**How each step becomes multi-repo (what the mock now draws):**

| Step                                                          | Multi-repo treatment                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connect** (Panel 1)                                         | "Connect the repositories in this project" — **multi-provider**: a **GitHub** card (Motir App) + a **GitLab** card (OAuth), then a **multi-select** repo list (acme/web · GitHub, acme/api · GitLab, acme/shared · GitHub — each provider-tagged) + a "**3 repositories** selected (2 GitHub · 1 GitLab)" summary. Reads through the `GitProvider` seam; GitLab client = MOTIR-1470. |
| **Index** (Panel 2)                                           | **One code graph across all repos**, built **per repo**: a `.idx-repo` list — each repo its own progress bar + state (`Indexed` / `Indexing…` / `Queued`) — under an **aggregate meter** ("2 of 3 repositories done · 78%"). The **gate is aggregate**: Next stays disabled until **every** repo finishes. Complete state = "3 of 3 indexed · 5,412 files · 31,208 symbols".         |
| **Conventions + code-health** (NOT an onboarding step)        | Derived **PER REPO** from the code + a code-health check, **auto-used, NO approval, NOT surfaced in onboarding** — the Index-complete state just notes "conventions + code-health derived, nothing to approve; on the Code health page". The audit + read-only View + chat-to-revise all live on the **Code-health page (7.14)**, post-onboarding.                                   |
| **Planning** (the universal plan screen — not a wizard panel) | Reached after the optional import step; grounded in the **whole-project code graph** across all repos — each proposed item carries a **repo tag** (`acme/api` / `acme/web`) and honours that repo's convention; cross-repo proposals (reminders reuse the API's service) read naturally. NOT designed here — the existing `PlanningWorkspace` (MOTIR-1193/1299).                     |
| **States** (Panel 4)                                          | Index failure is **per-repo** — "acme/api failed; the other 2 stay indexed · Re-run acme/api" (a scoped retry, not a full re-index). Resume names the whole set ("set up — paused before the optional import / plan steps").                                                                                                                                                         |

**Implications for the downstream build cards (flagged, not built here):**

- **MOTIR-931 (orchestration)** indexes **N repos** into the project code graph — a fan-out over the
  selected repos (mirrors `indexRepoIntoWorkspaceProjects`), with an aggregate "all repos done" gate
  before the audit runs.
- **MOTIR-1499 (state machine)** tracks **per-repo index status** (not a single boolean) so Save & exit,
  resume, and a per-repo retry all work; the step is "done" only when every repo is indexed.
- **MOTIR-934 (wizard UI)** renders the per-repo index list + the multi-select connect list; the repo↔
  project association captured at Connect is what a future refinement uses to stop indexing a repo into
  unrelated projects.
- **Set-up = Connect + Index (REQUIRED); everything after is OPTIONAL.** The state machine (MOTIR-1499)
  must let a user **complete onboarding at the end of Index** and leave import/planning un-run — onboarding
  is "done" once the codebase is linked + read, independent of whether a plan was generated. On
  Index-complete Motir **derives per-repo conventions + a code-health check silently** (no step, no
  approval). The wizard UI (MOTIR-934) wires the **decision** after Index and the **skip / finish-later**
  outs on the optional steps; the finish-early exit lands the user in the project where the
  **always-present `PlanWithAILauncher`** (`design/ai-chat` / MOTIR-1299) is the door to plan later.
- **Conventions + code-health: derive + auto-use, NO gate, on the Code-health page — a 7.14 re-scope.**
  The migrate wizard CONSUMES the derived per-repo conventions; it never surfaces or approves them. The
  7.14 story owner must: scope `CodingConvention` + `CodeAudit` to `(project, repo)` (7.14.3 / MOTIR-924);
  **drop the approval gate + free-edit**; show the convention **read-only** on the Code-health page with a
  **"refine with Motir"** entry that opens the **UNIVERSAL AI chat** (`PlanWithAILauncher` / the "M"
  callout → `PlanningWorkspace`, MOTIR-1193 / 1299) — **NOT a new convention-chat seam** (Yue). **Recommend
  a 7.14 re-plan** (out of this card's scope to execute) — no new AI capability, it reuses the universal
  chat.
- **All AI conversation rides ONE surface (Yue).** Planning (the migrate wizard's Generate/Review composes
  it via 7.3.1), the convention refine, project Q&A, task help — every AI chat is the **universal
  `PlanningWorkspace` / "Plan with AI" launcher** (the always-present top-bar pill + floating-"M" callout,
  "the home of ALL AI"). This card invents NO bespoke chat and NO planning panel: the migrate wizard
  **opens** the shared planning screen (after the import step, and via the top-bar Plan-with-AI) — it does
  not re-draw it.

---

## Mirror grounding (rung-1, VERIFIED this session — cited, not asserted)

The card names these; drawn as THAT guided, gated wizard:

- **CodeRabbit — connect-your-repo onboarding.** Install the GitHub App, pick "all" or "only select
  repositories"; it then reads the repo in full context. Grounds **Panel 1** (the two-grant connect +
  repo selection) and the "you pick the exact repos on GitHub" honesty. —
  https://docs.coderabbit.ai/platforms/github-com
- **Cursor — codebase-indexing PROGRESS + a completion gate.** Cursor shows an indexing progress
  indicator and code-dependent capability is unavailable until the index completes. Grounds **Panel 2**
  (the index-progress step with **Next DISABLED until the index is ready**). —
  https://cursor.com/docs/context/codebase-indexing
- **Plane — the Jira-import WIZARD.** A stepped connect → configure → map → **review + Confirm** flow
  that writes nothing until the final confirm. Grounds the overall **stepped, gated wizard** shape and
  the confirm-to-persist generate/review end (**Panel 5**). — https://docs.plane.so/importers/jira

(The audit/convention step additionally inherits the 7.14.1 mirror set — CodeScene CodeHealth™,
CodeRabbit `code-guidelines`, the ETH-Zurich auto-gen caveat that justifies the **Approve** gate — from
`design/coding-convention/design-notes.md`, cited there, not re-argued here.)

---

## The spine — a set-up wizard, then a full-screen plan screen (the model this draws)

1. **A grouped rail during SET-UP; then a full-screen plan screen with NO left nav.** The set-up wizard's
   rail is split into **"Set up your codebase" (required)** — **`Connect · Index`** — and **"Import your
   work · optional"** — **`Import work items`**. Each step's state: **done** (mint check), **current**
   (accent marker + an `--el-accent-on-surface` ring row), **upcoming** (quiet outline marker), **optional**
   (a **dashed** marker). A `.rail-group` header carries the tier name; the optional tier's header carries
   an `optional` chip. The required steps are numbered (`Connect 1 · Index 2`); **Import work items** uses a
   **download-icon** marker. **★ After the (optional) import step the user LEAVES the rail entirely** — they
   land on the **full-screen universal plan screen** (§Panel 0), which has **NO left nav**; the finished
   set-up steps re-appear there as **done-cards** (Yue, 2026-07-07).
2. **★ The required core is just Connect + Index; conventions + code-health are derived SILENTLY, not an
   onboarding step (Yue, 2026-07-05).** Linking + reading the code must NOT force any commitment or
   "worry". Once the code is indexed, Motir **derives per-repo coding conventions + a code-health check
   from the code and uses them automatically** — **nothing to approve, nothing surfaced in onboarding**.
   (A user shouldn't have to evaluate a Node-layering rule; the conventions are grounded in the _real
   code_, which is the curation the ETH-Zurich "no blind auto-gen" caveat actually wanted — a non-expert
   rubber-stamp is not.) The Index-complete state carries a one-line pointer ("conventions + a code-health
   check derived — nothing to approve; on the _Code health_ page"); the audit report + the read-only
   **View** + **chat-to-revise** all live on the **Code-health page (7.14), post-onboarding** — reachable
   by whoever wants them, never a wizard step.
3. **★ Import is optional; then you LAND on the full-screen plan screen (Yue, 2026-07-07).** After Connect
   - Index, the **Import work items** step is skippable ("Skip — no backlog to import"). Whether the user
     imports or skips, the forward CTA (**"Open planning workspace"**) drops them onto the **full-screen
     universal plan screen** (§Panel 0) — the EXISTING `PlanningWorkspace` (MOTIR-1193/1299), **no left nav**
     — where the finished steps show as **done-cards** (Connected · Indexed · Imported) and Motir proposes a
     code-aware plan **reconciled with the import**. Finishing without planning ("Finish — plan later" /
     Save & exit) drops the user into the project instead; **"Plan with AI"** in the top bar reopens the plan
     screen any time. (This REPLACES the earlier locked-Generate gate, the convention approve-step, AND the
     bespoke discovery/generate panels — all gone; planning is the one existing plan screen.)
4. **The index gate (Cursor mirror) — aggregate across repos.** `Next` on step 2 is **disabled** (a
   `.btn.disabled`) until the code graph is built for **every** repo — Motir derives conventions + a
   code-health check (and any plan) from the whole project. Drawn in an **in-flight** state (per-repo
   `.idx-repo` rows + an aggregate `.idx-meter` at 78% + "2 of 3 repositories done" + Next disabled) and a
   **complete** state ("3 of 3 indexed" pill + "conventions + code-health derived, nothing to approve" +
   Next enabled).
5. **Resumable — Save & exit / resume.** The brand bar carries a **Save & exit** control (lucide
   `History`, the exit half of the save→resume loop, MOTIR-1488 vocabulary). Every step persists its
   result (MOTIR-1499's `MigrateOnboarding` state machine + MOTIR-931's resumable routes), so a drop or
   a deliberate exit **returns the user to the exact saved step** — drawn as the **Resume** state in the
   states panel ("Welcome back … set up — paused before the optional import / plan steps").
6. **A Back / Next footer** on every step (`--el-border` top hairline; Back secondary, the forward CTA
   primary — named per step, e.g. "Next: index the code", "You're set up", "Add 4 items to
   your backlog").

---

## Panels (inspect EVERY panel — the multi-panel rule, mistake #31)

### Panel 0 — REMOVED: the wizard's ending is a REGULAR PLANNING SESSION, and it is not drawn here

**Superseded 2026-09-06 (MOTIR-4766), at Yue's direction.** The panel drew a bespoke landing —
finished-step done-cards, a `.plan-lead` reading _"**Your codebase is in Motir.** Here's a plan grounded
in your code…"_, a `.canvas` already full of dashed **proposed** subtask nodes, and a confirm bar reading
_"6 proposed · nothing saved yet"_. That depicts **a planner that had read the repository and handed over a
plan nobody asked for**, and that is not what a planning session is.

**A REGULAR session arrives with the context and WAITS to be told what to plan.** The code graph, the
imported backlog and the direction are what it has; the user's ask is what it acts on. It asks; it does not
propose a tree unprompted. That is the same behaviour `motir-ai`'s routing verdict names for its
`continue` outcome (**MOTIR-4767**: _the session asks and plans exactly as a regular session does_), and it
is what a person doing a planning pass by hand actually experiences.

**So there is nothing migrate-specific to draw at the end of this wizard.** Set-up finishes, the universal
plan window opens, and the session begins the way every session begins — on this project, on any project,
on any day. The design of record is `design/ai-chat/planning-workspace.mock.html` (MOTIR-1193 / MOTIR-1299)
and, for a project arriving with never-approved onboarding, `design/ai-chat/reading-and-handoff.mock.html`
(MOTIR-4766). The panel's slot in the mock is now a NOTE saying this, rather than an absence: a panel
removed with no reason attached is one the next card re-draws.

**This document's own model said so before the panel contradicted it** — §The spine already reads _"Planning
is NOT designed here — it is the EXISTING universal plan screen"_. Where earlier sections below still speak
of _"the landing"_, _"the done-cards"_ or _"§Panel 0"_ as drawn surfaces, they are describing this removed
panel; the mechanism they describe (set-up finishes → the plan window opens) is unchanged, the **pixels are
not this asset's**. The `.plan-screen` / `.done-card*` / `.plan-lead` / `.plan-body` / `.canvas` / `.node` /
`.confirm-bar` / `.chat` / `.bubble` / `.composer` rules went with the markup rather than being left as a
set a later panel could quietly re-adopt.

### Panel 1 — Connect repos (step 1) — MULTI-PROVIDER (GitHub + GitLab) — **composes 7.7.1 (`design/github/`) via the `GitProvider` seam**

The connect surface as step 1, framed as **multi-repo + multi-provider** (§Multi-repo above). H1
**"Connect the repositories in this project"**, lead "A project usually spans more than one repository —
and they can live on **GitHub or GitLab** (a project may span both). Connect the host(s) your repos are
on…". The cite reads "Composes 7.7.1 · design/github/ · reads through the **GitProvider seam (`lib/git`)**
— GitLab is provider MOTIR-1470". **Two provider cards:**

- **GitHub — the Motir App** (`seclabel` "GitHub"): the composed 7.7.1 two-step grant — two `.grant-row`s
  (**Step 1 · Identity** "Verify your GitHub identity" · public profile only, no code access; **Step 2 ·
  Repository access** "Install the Motir GitHub App" · you pick the exact repos) + the **"Connect GitHub"**
  primary `Button` (github-mark). Owned by 7.7.1 — cited, not re-designed.
- **GitLab** (`seclabel` "GitLab"): a parallel provider card — one `.grant-row` (**OAuth · you pick the
  projects** "Authorize Motir on GitLab" · gitlab.com or self-managed; "same provider seam as GitHub —
  repos from both hosts join one project") + a **"Connect GitLab"** secondary `Button` (gitlab tanuki
  mark). This is the NEW multi-provider affordance; the runtime GitLab client is **Story MOTIR-1470**.

Then the **multi-select repo list** (`repo-row`s: repo icon + `owner/name` + a `main` branch `code` chip +
a **provider `Pill`** (`GitHub` / `GitLab`) + a **Selected** `Pill` + a `Switch`) — **acme/web (GitHub) ·
acme/api (GitLab) · acme/shared (GitHub)**, showing a project that spans BOTH hosts — with a "**3
repositories** selected (2 GitHub · 1 GitLab)" summary + the honest out ("update the Motir App's access on
GitHub, or your GitLab project authorization"). Each repo persists with its `provider` discriminator;
index / audit / plan read it provider-agnostically through the seam.

### Panel 2 — Index progress (step 2) — **NEW (the step this card owns)**

The code-graph indexing step (Cursor mirror), drawn **multi-repo** (§Multi-repo above). Eyebrow "Step 2
of 6", H1 **"Indexing your codebase"**, lead "Motir builds **one code graph for the project across all
three repositories** — files, symbols and how they reference each other, **including across repos** …".
An **in-flight** card: a `.spin` ring + "Building the code graph…" + "**2 of 3 repositories done** · you
can leave this step…" + a sky `78%` pill + the aggregate `.idx-meter`, then a **per-repo `.idx-repo`
list** — each repo a row with its own mini progress bar + state `Pill`: **acme/web** `Indexed` (mint,
100%, "2,104 files · 14,318 symbols") · **acme/api** `Indexing…` (sky, 62%) · **acme/shared** `Queued`
(neutral, 0%). An info `.callout`: **"Next stays disabled until every repository finishes"** and the
forward CTA drawn as `.btn.disabled` (the **aggregate** gate). Then a **complete** state (mint "**3 of 3
indexed**" pill · "Code graph built · 3 repositories · 5,412 files · 31,208 symbols" · Next enabled). The
index feeds the whole-project code graph that the silent conventions + code-health derivation, and any plan, read (the `codeGraphRef`).

### Conventions + code-health are NOT an onboarding step — derived silently (the removed "Panel 3")

An earlier draft made "Audit & conventions" a **required** onboarding step (per-repo review + **approve**).
**Removed (Yue, 2026-07-05): the user shouldn't have to worry about, approve, or even see the coding
convention during onboarding.** Once the code is indexed, Motir **derives per-repo conventions + a
code-health check from the code and uses them automatically** — **no approve, no view, no chat in
onboarding**. The Index-complete state (§Panel 2) carries only a one-line pointer ("conventions + a
code-health check derived — nothing to approve; on the _Code health_ page"). The audit report + the
read-only **View** + **chat-to-revise** all live on the **Code-health page (7.14), post-onboarding** —
discoverable by whoever wants them, never a wizard step. This is grounded in the _real code_, which is the
curation the ETH-Zurich "no-blind-auto-gen" caveat actually wanted (a non-expert rubber-stamp is not); it
also matches how chat-first builders (Lovable / Bolt / Replit) treat code style — invisibly.

⚠️ **This re-scopes the 7.14 coding-convention story (flagged, not owned here — the migrate wizard only
CONSUMES the derived conventions).** The 7.14.5 review/approve UI (MOTIR-926, the `/code-health` page)
**ships today** with a **free-edit Textarea + an Approve gate** (`design/coding-convention`). The new
model is: **derive + auto-use (NO approval gate); read-only VIEW; refine via the UNIVERSAL AI chat.** On
the 7.14 side that needs: **(1)** drop the approval gate (the convention is used automatically);
**(2)** on the Code-health page, show the convention **read-only** with a **"refine with Motir"** entry
that **opens the EXISTING universal AI surface** — the `PlanWithAILauncher` / floating-"M" callout →
`PlanningWorkspace` chat (`design/ai-chat` / MOTIR-1193 / MOTIR-1299, "the home of ALL AI": _Plan with AI_
· _Ask about this project_ · _Help with a task_), scoped to that convention. **Do NOT invent a new
convention-chat seam (Yue)** — refining a convention is just another intent of the universal AI chat, like
planning or asking; **(3)** a **design amendment** to `design/coding-convention` (remove approve +
Textarea; add read-only View + the universal-chat entry); **(4)** a **code change** to MOTIR-926.
Also still open from §Multi-repo: conventions are **per repo**, not one per project. **Recommend a 7.14
re-plan.** (No new AI capability to build — it reuses the universal chat surface.)

### Panel 3 — Import work items (**OPTIONAL**) — **composes `design/import` (7.16.1 / MOTIR-937), embedded not redrawn**

The **optional import step** — bring an existing backlog (Jira / Linear / GitHub / Plane / CSV) into the
project. Eyebrow "Optional · Import & plan", H1 **"Bring in your existing backlog"**, lead frames it as
optional + names the reconcile. **This step COMPOSES the shipped import-wizard design
[`design/import`](../import/design-notes.md) (7.16.1 / MOTIR-937), embedded — NOT redrawn** (#82): the
migrate wizard owns the _embedding_ (the import wizard's own design-notes explicitly assigns "composed
into onboarding as step 2 … owned by the onboarding side, MOTIR-930/934"). Drawn as: a `.substeps`
sub-rail of the importer's own four steps (**Connect → Map → Preview → Import**, Connect current) + the
note "the full flow runs here — **nothing is written until you confirm the dry-run preview**"; a
`.src-grid` source picker (five `.src` tiles — Jira `--el-tint-sky` · Linear `--el-tint-lavender` ·
GitHub `--el-tint-mint` · Plane `--el-tint-rose` · CSV `--el-tint-peach`, the exact tint slots
`design/import` assigns, Jira selected); and an accent **`.callout.info-accent` reconcile** note:
"**Imported items reconcile with your plan** — when you plan next in your workspace, Motir de-dupes
against the imported backlog; an imported ticket wins, generation only adds the gaps your code implies."
Footer: Back · **"Skip — no backlog to import"** · **"Finish — plan later"** · the primary
**"Open planning workspace"** (sparkle) — which opens the existing plan screen. The step is wired by
[MOTIR-1643] (the import-step state machine + reconcile) and built by [MOTIR-934]; the importer engine +
its standalone wizard are [MOTIR-816] / [MOTIR-942]. **The importer's Connect/Map/Preview/Import internals
are OWNED by `design/import` — cited, not re-specified here.**

### Planning is the EXISTING full-screen plan screen — you LAND on it, no left nav (Yue, 2026-07-07)

The migrate flow designs **no discovery / generate / review panels**. Planning is the **universal plan
screen that is already implemented** — the `PlanWithAILauncher` → `PlanningWorkspace` (MOTIR-1193 /
MOTIR-1299, `design/ai-chat/planning-workspace`), the ONE surface every AI-planning flow already uses. It
is **full-screen with NO left nav**. So this card does **not** re-draw the plan screen (compose-don't-redraw,
#82); it draws **the LANDING on it** (§Panel 0) — which is where the migrate-NEW work lives: the
**finished-step done-cards** (Connected · Indexed · Imported, so progress shows as cards, not a rail) + the
**reconcile framing** (the plan de-dupes against the imported backlog). ⚠️ Two earlier drafts were wrong
here — (a) a rail-handoff "Plan your project" step, and (b) a bespoke "chat"/generate panel; **neither is
the universal plan screen. You LAND on the real full-screen screen (no left nav), with the finished steps
as cards.**

**How it's reached.** After the (optional) **Import work items** step (import OR skip), the forward CTA
**"Open planning workspace"** drops the user onto Panel 0 — the full-screen plan screen. It is also
reachable any time from **Plan with AI** in the top bar. There is **no "Plan your project" rail step** — the
set-up rail ends at Import; the plan screen is a separate full-screen surface you transition to.

**Nothing to design/build here for the plan screen itself** — the wizard UI subtask (MOTIR-934) transitions
the user onto the shipped `PlanningWorkspace` after import and renders the migrate-specific done-cards on
it; it does not build a planning surface.

### Panel 4 — finished-early / error / resume states

Four states in a `.states-grid`: the ★ **finish-at-set-up exit** — a mint `EmptyState` **"Your codebase
is in Motir"** ("3 repositories connected, indexed and conventions reviewed. You didn't have to plan
anything — start whenever with **Plan with AI**") with a **"Plan with AI"** + "Go to project" — the
concrete payoff of optional planning; **Index failed — one repo, per-repo retry** ("acme/api failed; the
other 2 stay indexed · Re-run acme/api" — a scoped retry via `.callout.danger`); **Connect failed**
("Couldn't reach GitHub · your place is saved · Retry connect"); and **Resume** ("Welcome back … Your
import (3 repositories) is set up — paused before the optional import / plan · Resume — import or plan / Go to project"). A
footer note ties resume + per-repo index status + per-repo convention approval to MOTIR-1499's
`MigrateOnboarding` state machine + MOTIR-931's resumable routes, and states the finish-early-plan-later
contract.

---

## Which Story owns each embedded surface (compose + cite, don't duplicate)

| Step / surface                                  | Owner (design → build)                                                                                                                                             | This card                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Wizard chrome + step rail + gate**            | **MOTIR-930 (this design) → MOTIR-934 (UI) + MOTIR-931 (wiring) + MOTIR-1499 (state)**                                                                             | designs                                                             |
| **Index-progress step**                         | **MOTIR-930 (this design)** — the NEW step it owns                                                                                                                 | designs                                                             |
| Connect repos (step 1, GitHub + GitLab)         | **7.7.1** — `design/github/` (GitHub, build MOTIR-895) · **GitProvider seam** `lib/git` (MOTIR-891) · **GitLab provider = MOTIR-1470**                             | composes GitHub; draws the multi-provider surface, flags MOTIR-1470 |
| Conventions + code-health (derived, NOT a step) | **7.14.1** — `design/coding-convention/` (audit + view + chat-to-revise live on the Code-health page, post-onboarding)                                             | consumes                                                            |
| **Import work items (optional)**                | **7.16.1 / MOTIR-937** — `design/import/` (importer MOTIR-816; wired MOTIR-1643)                                                                                   | composes                                                            |
| Planning (discovery / generate / review)        | **The EXISTING universal plan screen** — `PlanWithAILauncher` → `PlanningWorkspace` (MOTIR-1193 / 1299), already built                                             | opens (not designed here)                                           |
| The `/onboarding/migrate` host route            | **MOTIR-930 (this design) → MOTIR-934 (UI)** — the wizard's OWN route in the `(onboarding)` group (`/onboarding/import` is the issue importer, 7.16.6 / MOTIR-942) | owns (route amended — MOTIR-1710)                                   |

If a step needs a design-system entry none of the above owns, that is a **NEW `design/` subtask**, not
a code workaround (the AC). None is introduced here — the rail, the chrome, and the index step compose
only shipped primitives.

---

## Per-element `--el-*` colour role (the token map)

Colour flows through Tier-3 `--el-*` ONLY — no Tier-0 `--color-*` in product UI, no invented hue (the
`motir-core/CLAUDE.md` colour rule; mistake #54). Every coloured chip carries the hue in the TINT
background with `--el-text-strong` ink, AA-safe in both themes (finding #35).

| Element                                    | Token(s)                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page / wizard frame                        | `--el-page-bg` bg · `--el-border` edge · `--shadow-card`; brand bar `--el-surface-soft`                                                                                                 |
| Brand tile · avatar                        | `--el-tint-lavender` / `--el-tint-mint` fill + `--el-text-strong` ink                                                                                                                   |
| Save & exit control                        | `--el-text-secondary` (lucide `History`)                                                                                                                                                |
| Rail — **done** step                       | marker `--el-success-surface` bg + `--el-success` check; connector spine `--el-success`; name `--el-text-strong`                                                                        |
| Rail — **current** step                    | row `--el-surface-soft` + a `--el-accent-on-surface` outline; marker `--el-accent` + `--el-accent-text`                                                                                 |
| Rail — **upcoming** step                   | marker `--el-page-bg` + `--el-border-strong` outline + `--el-text-faint`; name `--el-text-secondary`                                                                                    |
| Rail — **optional** step                   | marker `--el-page-bg` + a **dashed** `--el-border-strong` outline + `--el-text-muted`; name `--el-text-secondary` (reachable, not padlocked)                                            |
| Rail group headers                         | `.rail-group` `--el-text-secondary` (mono); the `optional` chip `--el-accent-on-surface` on `--el-callout-bg`                                                                           |
| Decision block (`.decision`)               | `--el-surface-soft` fill + an `--el-accent-on-surface` border; the "Plan with AI" `.ai-pill` = `--el-accent` fill + `--el-accent-text` (matches the top-bar launcher)                   |
| "Plan with AI" launcher (`.plan-ai`)       | `--el-accent` fill + `--el-accent-text` pill in the top bar — the always-present entrance (composes `design/ai-chat` / MOTIR-1299)                                                      |
| Step eyebrow · H1 · lead                   | `--el-text-eyebrow` (mono) · serif `--el-text` · `--el-text-secondary`                                                                                                                  |
| "Composes N" cite chip                     | `.cite` → `--el-callout-text` on `--el-callout-bg` (lavender = the compose/reference identity)                                                                                          |
| Card surface + edge                        | `--el-card` bg · `--el-border` · `--shadow-subtle`; a quiet aside is `.card.soft` on `--el-surface-soft`                                                                                |
| Primary / secondary / ghost / disabled CTA | `--el-accent`+`--el-accent-text` · `--el-page-bg`+`--el-button-border` · `--el-text` · `--el-muted`+`--el-text-faint`                                                                   |
| Index meter                                | track `--el-muted` · fill `--el-accent`; the spinner ring `--el-border-strong` + head `--el-accent-on-surface`                                                                          |
| Index stat tiles                           | `--el-surface-soft` + `--el-border`; number serif `--el-text-strong`, label `--el-text-muted`                                                                                           |
| Per-repo index row (`.idx-repo`)           | `--el-border` + `--radius-control`; per-repo bar track `--el-muted` + fill `--el-accent` (done → `--el-success`); state `Pill` mint `Indexed` / sky `Indexing…` / neutral `Queued`      |
| Info callout / progress note               | `--el-surface-soft` + `--el-border`; icon `--el-info`                                                                                                                                   |
| Grade tile (audit)                         | `--el-success-surface` bg + `--el-text-strong` (a B grade; a poor grade falls to `--el-warning`/`--el-danger`-surface)                                                                  |
| Category dots                              | `--el-success` (ok) · `--el-warning` (watch) · `--el-danger` (gap) — each paired with a redundant text label                                                                            |
| Provenance — Adopted / Proposed            | `Pill` `--el-tint-mint` (Adopted) / `--el-tint-lavender` (Proposed), `--el-text-strong` ink                                                                                             |
| Sync / selection / status pills            | tints `--el-tint-{mint,sky,peach,rose,lavender}` + `--el-text-strong`; neutral `--el-chip-bg`/`-border`                                                                                 |
| Grant-row icon badge                       | `--el-card-icon-bg` (lavender) + `--el-card-icon-fg`                                                                                                                                    |
| Branch / code chip                         | `--el-code-bg` + `--el-code-text` (mono)                                                                                                                                                |
| Switch (repo sync)                         | on `--el-switch-on` · off `--el-muted`+`--el-border-strong` · knob `--el-switch-knob`                                                                                                   |
| Chat — AI / user bubble                    | AI `--el-surface-soft`+`--el-border`+`--el-text`; user `--el-accent`+`--el-accent-text`; composer field `--el-input-border`                                                             |
| Canvas + proposed node                     | canvas `--el-canvas` (+ a `--el-border-strong` dot-grid, non-semantic); node `--el-card`; **proposed** = dashed `--el-accent-on-surface` on `--el-surface-soft`                         |
| Confirm-to-persist bar                     | `--el-surface-soft` + an `--el-accent-on-surface` border; "N proposed" `--el-tint-lavender` pill                                                                                        |
| Danger callout / error icon                | `.callout.danger` → `--el-danger-surface` fill + `--el-text-strong` ink + `--el-danger` icon                                                                                            |
| EmptyState (error / resume)                | icon tile `--el-muted`/`--el-icon-muted` (danger → `--el-danger-surface`/`--el-danger`; resume → `--el-tint-lavender`/`--el-accent-on-surface`); serif title; `--el-text-subtitle` desc |

**Shape** flows through element-semantic shape tokens ONLY (no raw `rounded-*`/`p-*`/`h-*`; the
`motir-core/CLAUDE.md` shape rule — the layer a `[data-style]`/`[data-display-style]` block overrides):
cards `--radius-card` + `--spacing-card-padding`; buttons `--radius-btn` + `--height-btn-{sm,md}` +
`--spacing-btn-x`; pills `--radius-badge` + `--spacing-chip-{x,y}`; rail rows / repo rows / stat tiles /
code chips `--radius-control`; inputs `--radius-input` + `--height-control` + `--spacing-input-{x,y}`;
elevation `--shadow-{subtle,card}`. `rounded-full` (`--radius-badge`) only on markers / dots / avatar /
switch knob.

---

## Primitives composed (no hand-rolling) — the checklist (1.3.3 / 1.5.1 / 7.0.1)

Every element maps to a shipped `components/ui/*` primitive; the mock hand-writes CSS reproducing each
primitive's shipped classes/tokens (annotated). No new design-system entry is invented in this Story —
if one were needed, that is a NEW `design/` subtask, not a code workaround.

- [x] **Card** (`components/ui/Card.tsx`) — every step's content cards, the connect/repo/index/audit/
      convention cards, the EmptyState roots, the chat card, the confirm bar container.
- [x] **Button** (`components/ui/Button.tsx`) — primary (Connect / Approve & set as standard / Add N to
      backlog / Next), secondary (Back / Set from defaults), ghost (Cancel / Skip / View), and the
      **disabled** state (the index gate's Next); sizes md + sm.
- [x] **Pill** (`components/ui/Pill.tsx`) — provenance (Adopted `success` / Proposed `status=planned`),
      sync/selection/progress (`Selected` mint, `61%` sky, `Not selected` neutral), and the `N proposed`
      lavender count. No custom tone invented — all are shipped `Pill` variants.
- [x] **Switch** (`components/ui/Switch.tsx`, `role="switch"`) — the per-repo sync toggle (Panel 1).
- [x] **EmptyState** (`components/ui/EmptyState.tsx`) — the connect-failed + resume states (Panel 6):
      Card root, centred icon tile + serif title + `--el-text-subtitle` desc + action.
- [x] **Input / composer** grammar — the discovery chat composer AND the **convention chat-to-revise**
      composer ("Tell Motir what to change…"). The convention is **read-only** (a **View**, not a Textarea
      free-edit) — revised via chat, mirroring the onboarding read-only-doc + react-in-chat model (the
      `design/ai-chat` "no inline editing" rule). Approve is the only write the user performs.
- [x] **Spinner** (`components/ui/Spinner.tsx`) — the index `.spin` ring + the "Reading your codebase…"
      generating state (annotated, not re-implemented).
- [x] **The set-up step rail** (Connect · Index required · Import optional) — a NEW ARRANGEMENT of
      `Card`/list-row grammar + tint marker tiles + `.rail-group` tier headers + lucide `check`,
      generalising the `design/coding-convention` Panel 5 wizard step-strip. Done/current/upcoming/**optional**
      states pair a glyph or a dashed marker + a label + a tint (never colour-alone — finding #35). The rail
      exists ONLY during set-up; the landing (§Panel 0) has no rail.
- [x] **The per-repo index list** (`.idx-repo`) + **the per-repo convention list** (`.conv-repo`) — NEW
      ARRANGEMENTS of list-row grammar + a progress bar / grade tile + shipped `Pill` tones, so a
      **multi-repo** project indexes with per-repo status (aggregate gate) and reviews **one convention
      per repo**. No new primitive.
- [x] **The landing done-cards** (`.done-cards` / `.done-card`) — the finished set-up steps (Connected ·
      Indexed · Imported) shown as `Card`-grammar cards with a mint-check tile, on the full-screen plan
      screen (§Panel 0); + the always-present top-bar **"Plan with AI"** launcher (`.plan-ai`, composes
      `design/ai-chat` / MOTIR-1299). No new primitive.
- [x] **The optional import step composes `design/import`, embedded not redrawn** (#82) — the `.substeps`
      sub-rail (Connect → Map → Preview → Import) + the `.src-grid` source picker (5 `.src` tiles on the
      exact `--el-tint-*` slots `design/import` assigns) are a compact EMBED that cites the importer's own
      asset; its Connect/Map/Preview/Import internals are NOT re-specified here. New arrangement of `Card` +
      tile grammar; no new primitive.
- [x] **The embedded surfaces compose their OWN primitives** — Connect = 7.7.1's grant-rows + repo-rows (a **multi-select** repo set) + Switch; Import = `design/import`'s wizard (embedded); Planning = the LANDING (§Panel 0) — after import the user transitions onto the existing full-screen `PlanningWorkspace` (MOTIR-1193/1299, NO left nav), where this card adds the migrate-specific **done-cards**; the canvas/chat is the shipped surface, not re-designed. Reproduced from their
      shipped assets, **not re-designed**.
- [x] Icons are **lucide** (`Sparkles`, `History`, `check`, `github`, `badge-check`, `layout-grid`,
      `database`, `info`, `send`, `circle-check`, `triangle-alert`, `refresh-cw`, `arrow-left`,
      `arrow-right`, `pencil`) at `viewBox="0 0 24 24"`, stroke 2, round caps — matching the shipped
      surfaces.

### Token / a11y rules honoured

- Colour strictly via `--el-*` (incl. `--el-tint-*`); no Tier-0 `--color-*` in product UI, no invented
  hex/rgb/named colour, no `color-mix` over a raw hue (mistake #54). The only raw values are the
  non-semantic elevation shadows, the `--el-overlay-scrim`, and the canvas dot-grid texture — never a
  card/pill/state fill, border, or text colour.
- Shape strictly via element-semantic shape tokens; no raw `rounded-*`/`p-*`/`h-*` for a surface's own
  box (the shape rule) — so a `[data-style]`/`[data-display-style]` swap re-shapes the whole wizard.
- **Not colour-alone** — every rail state pairs a glyph (check / number) or a **dashed** marker + a
  label + a tint; the optional steps sit under a labelled `.rail-group` ("optional" chip); per-repo
  index/convention states pair a `Pill` word + a tint; the disabled Next carries `aria-disabled`; the
  rail is an `aria-label`led `nav` and the current step is `aria-current="step"`.
- **AA holds** — every coloured chip/tile carries the hue in the tint background with `--el-text-strong`
  ink; dark parity verified by toggling `data-theme="dark"` (every `--el-*` re-skins through the
  `[data-theme='dark']` `--color-*` overrides).

---

## AMENDMENT (2026-09-06 · MOTIR-4755) — a step SATISFIED BY THE SUBSTRATE, not by the user

**Story:** [MOTIR-4753] _The DEPTH of onboarding is a judgement about the project's SUBSTRATE._
**Panel added:** **Panel 5**. Everything above is unchanged.

### The premise this card was written on, AMENDED ON THE RECORD

The card opens: _"The migrate wizard's asset draws its step rail with `Discovery (step 4, 7.2.1)` as
an unconditional row, and it draws exactly one way for a step not to run: import's SKIP."_ **Both
halves are false, and both were checkable in one read at plan time.** Verified (rung 2) before
drawing:

- **The asset draws NO discovery row at all.** `grep -n 'Discovery' onboarding-migrate.mock.html`
  returns exactly one line — `/* ---- Discovery (step 4, 7.2.1) ---- */`, a **CSS section comment**,
  left from an earlier revision. All three rails in the asset draw Connect · Index · Import work
  items and stop.
- **And that is FAITHFUL to the shipped wizard**, which is why nobody noticed. `MigrateWizard.tsx`'s
  `Rail` renders exactly those three `RailStep`s and pushes to `/onboarding/discovery` from the
  discovery step onward — the direction tiers are a different route, drawn nowhere in this rail.
- **The rail draws no SKIPPED state either.** `RailStep`'s state union is
  `'done' | 'current' | 'upcoming' | 'optional'`, and a skipped import takes **`done`** (`rank > 2`),
  so today it is drawn identically to one the user completed. Import's skip is real as **copy** — an
  `onboardingMigrate.import.skip` button and _"Skip this if you have no backlog to bring in"_ — and
  the card quotes that correctly; what it does not have is a rail treatment to contrast against.

**The deliverable is unchanged and is if anything clearer**: this panel does not amend a row, it
ADDS one, in three states, and it has to DESIGN the user-skipped treatment rather than reproduce it.
The card's own _"draw the import row's skipped state beside it"_ already asked for exactly that.

### What Panel 5 depicts, and where each behaviour came from

**GROUNDED, NOT INVENTED.** Every behaviour below is read off a sibling card's `descriptionMd`; this
asset decides how it LOOKS and nothing about what it DOES.

| depicted                                                           | grounded in                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A direction row that does not run because the substrate answers it | **MOTIR-4759** — _`discovery` becomes a SATISFIABLE migrate step, not a mandatory one_                             |
| That the wizard ADVANCES past it rather than the user skipping it  | MOTIR-4759's _"the wizard advances past it when the substrate read says the repository and the backlog answer it"_ |
| The FLOOR — no repository and no backlog ⇒ the questions asked     | MOTIR-4759's _"the floor case still walks the tiers"_, and **MOTIR-4758**'s guaranteed floor (motir-ai)            |
| That the run RECORDS which way it went, so the surface can say so  | MOTIR-4759's _"the run records which way it went"_ — the provenance line is that record, rendered                  |
| That the entrance routes a repo-carrying project here by DEFAULT   | **MOTIR-4756** — the substrate read + `shouldRouteToMigrateWizard` deciding on both inputs                         |
| The two questions the satisfied row claims are answered            | **MOTIR-4758** — the test is the floor tiers' own questions (What/Who · In-v1/Out)                                 |

### The three states, and why none of them is the `done` tick

A step can fail to run for two opposite reasons. **SKIPPED is the user's** — they were offered a
thing and declined it. **SATISFIED is Motir's** — it read their repository and their backlog and did
not need to ask. Dressing the second in the first's clothes tells a user they passed on something
they were never shown; dressing either in the **done** tick says they did the step.

| row state                                      | marker fill                                                         | glyph             | name                           | meta line                                  |
| ---------------------------------------------- | ------------------------------------------------------------------- | ----------------- | ------------------------------ | ------------------------------------------ |
| `pending` (`.step.current`)                    | `--el-accent` on `--el-surface-soft`, ring `--el-accent-on-surface` | **question mark** | _"A few questions"_            | _"What you're building, and who for"_      |
| `user-skipped` (`.step.skipped`, NEW)          | `--el-muted`, border `--el-border`                                  | **dash**          | the step's own name            | _"You skipped this"_ — whose choice it was |
| `substrate-satisfied` (`.step.satisfied`, NEW) | `--el-tint-sky`, border `--el-border`                               | **book / read**   | _"Answered from your project"_ | _"Your code and your backlog said it"_     |
| `done` (unchanged)                             | `--el-success-surface`                                              | check             | the step's own name            | —                                          |

**Not colour-alone** (the standing rule): each of the three pairs a distinct GLYPH and a distinct
NAME-or-META with its tint, so the states are separable in greyscale and to a screen reader.

**And the pending marker is a QUESTION MARK, not a numeral.** Revision 1 numbered it `3`, which
invents a global sequence: the rail numbers Connect `1` and Index `2`, and Import carries a glyph, so
a `3` on the fourth row implies a step count that skips one. It also asserts a position this row does
not have — the direction stage is not the third of four steps, it is a stage that may not run at all.
A question mark says what the row is in the one character the marker has. (The SHIPPED `RailStep`
renders no glyph at all for `current` — an empty accent dot — so the numerals are this mock's own
flourish and were free to drop.)

### ⚠️ ONE ROW, AND IT NEVER NAMES A TIER (Yue, 2026-09-06)

**An earlier revision of this panel drew the direction stage as FOUR rows — Discovery, Vision,
Feasibility, Validation — and that was wrong for the same reason "Pre-plan" was wrong.** Those are
the planner's identifiers (`DirectionDocKind`, `producibleTiers`) for questions the user is simply
being asked. A rail that lists them by name teaches a stranger four words before it tells them
anything, and it does it on the first surface they ever see. **This is MOTIR-4757's rule one surface
over** — internal vocabulary travelling out of the rule corpus into user-facing text, written in
good faith by somebody who had just been reading the corpus — and a design asset is exactly where
that gets laundered into looking decided.

So the rail carries **one row** for the whole direction stage:

- **pending** — named _"A few questions"_, meta _"What you're building, and who for"_. The user is
  told what the step IS and what it is about; which four documents it produces is the planner's
  business.
- **satisfied** — the NAME carries the outcome, _"Answered from your project"_, because a row the
  user never saw has to explain itself in the one place they meet it. The meta line says which part
  of the project answered.

**And the FLOOR rail collapses with it.** It used to draw all four tiers to make the point that they
are all walked; it now draws the one row in its pending state, which makes the same point without
the vocabulary. Nothing about the floor's BEHAVIOUR changed — every question is still asked, and no
state above is reachable from there.

**⚠️ AND THE FLOOR'S SET-UP ROWS ARE `upcoming` / `optional`, NOT `skipped`.** A first draft drew
Connect with a dash and the meta line _"No repository"_, which reads as _the user skipped connect_ —
and **connect and index have no skip control**, so that is a state the machine cannot produce. A
design asset that draws one is worse than useless: the next person builds it. `skipped` is a thing
the user PRESSED, and the only step that offers it is import.

**What the consuming card owes is therefore SMALLER than the first revision implied:** one rail row,
not a four-row group. MOTIR-4759's sizing is amended accordingly.

**The board CHROME still says "discovery"** — the panel label, the state captions, this note. That is
deliberate and is the distinction the whole section is about: chrome is addressed to whoever builds
the surface, and the rail is addressed to whoever uses it. Only one of the two is a place the
planner's own nouns may appear.

### The PROVENANCE line — a statement, never a gate

Drawn in the hand-off panel, on the surface the user lands on:

> _Motir planned from **acme/widgets** and **214 imported work items**, so it did not ask you the
> direction questions. Everything below is a proposal — change anything before you add it._

- **It is not a question and not a confirmation**, and the flow does not wait on it. The depth
  decision is the planner's (MOTIR-4758) and what the user reviews is the PLAN it produced, so this
  is provenance, not an approval.
- **The escape beside it is a button, not a gate**: _"Answer the questions anyway"_. A plan that came
  out thin from a run that never asked anything needs the user able to see why and to reach the
  interview; it does not need the interview made mandatory again.
- Ink is **`--el-text-secondary`** on **`--el-surface-soft`** (6.51:1). `--el-text-muted` there is
  4.34:1 and would fail AA — the standing pair-not-ink rule, which is why the annotation ink in this
  panel is `--el-text-secondary` throughout.

### The ACCESS PATH

The existing-project tile on `/onboarding` (composes `design/onboarding-entrance/`), drawn at board
scale so a reader sees the door and not only the room. **It is no longer the only way in** — per
MOTIR-4756 the entrance now routes a project with a connected repository here by DEFAULT.

**Its copy is the SHIPPED copy, verbatim** — `onboarding.entrance.importTitle` / `importDesc` — and
**this card amends no entrance string**. An earlier draft of this panel rewrote the tile's body to
promise that Motir reads first; that promise is already in the shipped copy (_"Connect your
repository and Motir reads your code, then plans on top of what's already there"_), and inventing a
second wording would have left an unowned deliverable in a design asset with no card to build it —
the deferral-is-a-card shape, one layer over. Drawn as it ships, the door already makes the promise
the rail below keeps.

### Vocabulary

**No panel, label or annotation in this asset uses "Pre-plan"** — it is corpus vocabulary, not the
product's, and the sibling **MOTIR-4757** is retiring it from the two onboarding topbar strings. The
product's own noun is used throughout: **your direction**.

### Tokens this amendment adds to the asset (no new colours)

`.step.satisfied` · `.step.skipped` · `.provenance` · `.door` · `.rail-mini` · `.triptych` — composed
entirely from tokens the asset already declares: `--el-tint-sky`, `--el-muted`, `--el-surface`,
`--el-surface-soft`, `--el-card`, `--el-card-icon-bg` / `--el-card-icon-fg`, `--el-border`,
`--el-text-strong`, `--el-text-secondary`, and the shape tokens `--radius-card` / `--radius-control` /
`--radius-badge`. **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*` on a
surface's own box.**

---

## AMENDMENT (2026-09-06 · MOTIR-4766) — the PLANNER-DECIDED step set: a rail SHORTER than the full one

**Panel 6 of `onboarding-migrate.mock.html`.** MOTIR-4755 (the amendment above) gave ONE step that
did not run its own state. This amendment is what happens when SEVERAL of them do not run, because
the planner now returns which steps to KEEP.

### Where each depicted behaviour comes from (grounding, not invention)

| Behaviour drawn                                                  | Grounded in                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The kept-step set exists at all, and is the PLANNER's answer     | **MOTIR-4767** — the routing verdict. On `onboard_existing_project` it carries THE KEPT STEPS and WHAT IS MISSING.       |
| The set travels to the wizard with the move                      | **MOTIR-4769** — "carrying the KEPT STEPS and the missing-list… `motir-core` does not second-guess the verdict."         |
| The wizard renders exactly that set                              | **MOTIR-4759** — `discovery` becomes a SATISFIABLE step; the run records which way it went.                              |
| A step may be satisfied by the substrate rather than by the user | **MOTIR-4755** (the amendment above) — the `satisfied` state, its sky tint and its read glyph. Reused here, not redrawn. |
| A kept step naming something the wizard does not have is refused | **MOTIR-4767 AC6** — validated upstream, so the rail never has to draw one.                                              |

### The decision — COLLAPSE, do not delete

The failure this panel is avoiding is MOTIR-4755's, at scale. That amendment established that a step
which silently vanishes reads as something taken from the user. With one step, the remedy was to
give the row its own state. **With three, giving each of them a `satisfied` row produces the
opposite problem**: a rail whose subject is the list of things the user did not do, sitting beside
the one thing they did.

So the steps that are not kept **collapse into ONE row, in the `satisfied` treatment, and that row
names them**:

```
YOUR DIRECTION                         →  ALREADY ANSWERED BY YOUR PROJECT
                                          [read] Connect, Index and Import
                                                 Read from acme/widgets and your 214 work items
```

The rail gets shorter; nothing vanishes. The group heading carries the sentence (_Already answered by
your project_) and the meta line says WHAT answered it — the same claim the provenance line makes at
the end of the flow, so the two cannot drift.

### Three states drawn, and why each is needed

1. **The FULL set** — no repository and no backlog, so the planner keeps everything and there is
   nothing to collapse. The rail is exactly the one that shipped. This is the floor, unchanged from
   MOTIR-4755's Panel 5, and it is here so the shortened rails have something to be shorter THAN.
2. **Planner kept ONE** — three steps collapse into a single row; `A few questions` is the only live
   step.
3. **Planner kept TWO** — a repository that is real but thin. **Connect and Index are satisfied and
   Import is not**, so the collapsed row sits ABOVE a live step it does not precede in the shipped
   step order. This case is drawn deliberately: it is the proof that the kept set is **not a prefix,
   a suffix or a count**, so the rail must render whatever the planner returns rather than "the last
   N steps".

### What the user is told at the end

The provenance line from MOTIR-4755 gains **one clause and no new mechanism**:

> Motir planned from **acme/widgets** and **214 imported work items**, and from the two answers you
> gave. **Connect, Index and Import** were already answered by your project, so it did not ask you
> about them. Everything below is a proposal — change anything before you add it.

It stays a STATEMENT, not a gate: the escape back to the interview is the same
_Answer the questions anyway_ button, and the flow does not wait on it.

### The four rules this panel holds itself to

1. **A step that is not kept is COLLAPSED, never deleted.**
2. **One collapsed row, not N satisfied rows** — the single-row treatment is right for one step and
   wrong for four.
3. **No row names a tier.** `discovery` / `vision` / `feasibility` / `validation` are the identifiers
   a kept-step set travels as (MOTIR-4767 validates against them) and they stay identifiers; the
   rail says _A few questions_ and _Your direction_, exactly as MOTIR-4755 revision 2 settled after
   Yue's note. **No string in this panel contains "Pre-plan".**
4. **The rail renders the verdict; it does not audit it.** No count, no threshold and no
   re-derivation from the substrate decides what is drawn (MOTIR-4769's own boundary).

### Primitives and tokens (nothing new)

`Rail` / `RailStep` as shipped in `app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx`
— the `.step` / `.marker` / `.s-name` / `.s-meta` structure, the `.rail-group` heading with its
`.opt` chip, and the `.step.satisfied` / `.step.current` / `.step.upcoming` / `.step.optional`
states. Panel 6 adds **no class, no colour and no shape token**: it is `--el-tint-sky` +
`--el-text-strong` + `--el-border` on the collapsed marker (the `satisfied` recipe verbatim),
`--el-surface` / `--el-surface-soft` / `--el-card` grounds, `--el-text-secondary` for every meta and
annotation line, and `--radius-card` / `--radius-control` / `--radius-badge` for shape. No raw hex,
no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*` on a surface's own box.

### Also in this pass — Panel 0 was REMOVED (Yue, 2026-09-06)

Not part of the kept-step work, but landed under the same card because the same mistake was in both
assets: Panel 0 drew a bespoke landing in which the planner had read the repository and handed over a
plan nobody asked for. **A regular planning session arrives with the context and WAITS to be told what
to plan.** Nothing about the end of this wizard is migrate-specific, so there is nothing here to draw;
the panel's slot is now a note saying why, and `design/ai-chat/`'s Panel 5 (the RETURN) was corrected
in the same pass for the same reason. Full record in §Panel 0 above.

### The other half of this design lives in `design/ai-chat/`

The hand-off that SENDS a user here — and shows them the kept set before they commit to it — is
`design/ai-chat/reading-and-handoff.mock.html` Panel 4, published under the same card. The two
assets share the `satisfied` vocabulary on purpose: the chip strip in the hand-off and the collapsed
row in the rail are the same fact, said once before the journey and once during it.

## 2026-10-12 — the vibe layout on the migrate wizard: the lockup in the bar, a hero and a work band (MOTIR-8251)

**Amends:** MOTIR-930's wizard (§ _Panels_, the `BrandBar` and every step panel, and § _Per-element
`--el-*` colour role_) and the MOTIR-4759 amendment above (the resume panel and the collapsed rail).
**Delta mock:**
[`onboarding-migrate--vibe-layout.mock.html`](./onboarding-migrate--vibe-layout.mock.html).
`onboarding-migrate.mock.html` is a record and is **not edited**. Story MOTIR-8238; sibling sections:
[`design/import/design-notes.md` § 2026-10-12](../import/design-notes.md) (the importer) and
[`design/ai-chat/design-notes.md` § 2026-10-12](../ai-chat/design-notes.md) (the discovery top bar,
the chat rail and the direction-doc page).

**Composes, never re-draws:** MOTIR-8250's Pattern panel —
`design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html` **Panel 6** (A the lockup ·
B the hero · C one section band) and
[`design/onboarding-entrance/design-notes.md` § 2026-10-11](../onboarding-entrance/design-notes.md).
`OnboardingHero`, `HeroWaves` and `OnboardingSection` are that card's product-local parts, built by
MOTIR-8252. This section adds one **variant** (the compact hero) and one composition (the work band),
and nothing else.

**Design system — files read:** root `package.json` (`"@motir/design-system": "workspace:*"`),
`app/globals.css` (line 13 `@import '@motir/design-system/theme.css'`, line 25
`@import '@motir/brand/brand.css'`), `packages/design-system/package.json` (**`0.13.0`**, exports
`./mock`), `app/layout.tsx`. No `DESIGN.md`. **Verdict: ON MOTIR DESIGN — branch (a).** The mock is
built with `renderMock` from the package's real `Button`, `Card`, `Pill`, `Spinner` and
`buttonVariants`; `BrandMark` (`lockup`, `glyph`) and `WAVE_BAND_PATH` come from `@motir/brand`
with `brand.css`'s lockup rules inlined. Axes are the `:root` defaults —
`data-style="warm-editorial"` · `data-palette="motir"` · `data-type="motir"` — and every frame is a
`[data-appearance-scope]` carrying `data-theme` and the axes. `--focus-ring-color` is re-pointed to
`--el-accent-on-surface` per frame, as MOTIR-8250 finding F4 did. Nothing is proposed for the package.

**Shipped reality read** at the branch head: `app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx` (the
`BrandBar`, `Rail`, `StepHead`, `PanelFoot` and the six panels), `messages/en.json` as MOTIR-8248 left
it. Every string drawn is read by key; none is typed. **motir.co, read and never imported** —
`motir-marketing` at `origin/main` **`06c0411`** (only ideas files changed since MOTIR-8250 read
`0c2e37b`): `motir-marketing/app/_components/SiteHeader.tsx` (no fill, no rule, `BrandTile` 28) and
`motir-marketing/app/_components/LanguageSwitcher.tsx` (the globe is the bar's LAST control).

### Panels (light AND dark)

| #   | Panel                                                                                                                                                   | frame   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0   | Access path — the entrance's import section door ("We can vibe it too") → `/onboarding/migrate`                                                         | 640 × 2 |
| 1a  | Arrival with only the default project — Start skipped, the wizard opens on **Connect** with the **full** hero — Revision 3                              | 1280    |
| 1b  | Start — only when the workspace has two or more projects: the bar, the **full** hero, the rail and the project choice (Revision 4)                      | 1280    |
| 2a  | Connect — compact hero, **Checking** (on arrival) — Revision 1                                                                                          | 1280    |
| 2b  | Connect — **Not connected yet** (Connect GitHub ↗ in a new tab, no Next) — Revision 1                                                                   | 1280    |
| 2c  | Connect — **Waiting for GitHub** (re-checks on focus and every ~5 s) — Revision 1                                                                       | 1280    |
| 2d  | Connect — **Connected** (detected repositories, Continue) — Revision 1                                                                                  | 1280    |
| 3a  | After Connect — straight on to Import, the indexing chip in the bar, Index as a background rail row — Revision 2                                        | 1280    |
| 3b  | The indexing chip opened — the per-repository detail popover over the step — Revision 2                                                                 | 1280    |
| 3c  | Reading failed — the chip and detail in their failed state, on Decision — Revision 2                                                                    | 1280    |
| 4   | Import — optional, with Skip (the chip at the moment reading finishes — Revision 2)                                                                     | 1280    |
| 5   | Decision — Plan now / Finish later, while the code is still being read (Revision 2)                                                                     | 1280    |
| 6   | Resume — a run in progress (MOTIR-4759)                                                                                                                 | 1280    |
| 7   | Error — the typed error alert inside the panel (drawn over 2b)                                                                                          | 1280    |
| 8   | Collapsed rail — the planner-decided set (discovery + import kept, MOTIR-4766)                                                                          | 1280    |
| 9   | Close-ups — 9a planAi / Save & exit rest·hover·focus · 9b language pending·failed·open · 9c indexing chip states (Revision 2) · 9d planNow rest·pending | 640 × 2 |
| 10  | Narrow — arrival on Connect (default project only), and Import with the code being read (chip closed, then opened) — Revision 3                         | 390 × 2 |
| 11  | Narrow — Connect 2b and 2d — Revision 1                                                                                                                 | 390 × 2 |

### What changes, and what does not

- **The bar.** The lavender tile with the AI glyph and the word "Motir" are TAKEN; the `BrandMark`
  **lockup** (22 px) takes their place as a non-link span — this bar has its own exits, and a third
  one on the logo would compete with Save & exit. Then `· {flowName}`, then, trailing: the planAi link
  (`secondary` sm, **its AI glyph TAKEN**, a trailing `ArrowRight`), Save & exit (`ghost` sm), the
  **language control** (MOTIR-8286, the same `AuthLanguageControl` as
  `design/auth/auth-frame--language-control.mock.html`), and the decorative user initial, which keeps
  the far edge. The bar has no fill and no rule, as motir.co's header.
- **The hero.** The **full** hero (H1 96 px, `pt-[56px] pb-[88px]`, waves) shows only on the ARRIVAL screen —
  Start with no run. Every later step gets the **compact** hero (H1 56 px, `pt-6 pb-12`, lede 17 px,
  the same waves) so the panel stays above the fold. Measured from the frame top at 1280: Start
  band 382 / heading 456 / last control 638; compact steps band 257 / heading 330; last control
  Connect 629, Index 918 (the repo list is tall), Import 624, Decision 495, Resume 463. The heading and
  the card start above a 768 px fold on every step.
- **The work band.** `OnboardingSection`'s band (`border-t --el-border`, `--el-page-bg`,
  `px-[38px] py-[48px]`) holds the existing rail + panel grid unchanged. There is no outer centred
  card any more; the panel card is the one card.
- **`StepHead`.** The heading moves to the section scale's floor, serif 34 (28 narrow). The eyebrow
  keeps its function and drops its accent look: mono 11, uppercase, 0.1 em, `--el-text-secondary`.
- **The Decision panel's planNow button loses its AI glyph** too (the card named only the bar).
- **Behaviour is unchanged on every step except Connect** (changed by Revision 1 below): the same routes, the same `PanelFoot` (still no Back —
  the shipped wizard never passes `onBack`, and the mock does not invent one), the same rail logic,
  the same error alert in `--el-tint-rose`.

### Per-element `--el-*` and shape role

| element                 | colour                                                                  | shape / size                               |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| bar                     | none (transparent on the hero's `--el-surface`)                         | `px-(--spacing-card-padding) py-4`         |
| lockup                  | `brand.css` (glyph + word in `--el-text`)                               | 22 px                                      |
| `· flowName`            | `--el-text-secondary`                                                   | 14 px                                      |
| planAi                  | `Button secondary sm`; **hover** `--el-page-bg` + `--el-border-strong`  | `--radius-btn`, `--height-btn-sm`          |
| Save & exit             | `Button ghost sm`; **hover** `--el-page-bg`                             | `--radius-btn`, `--height-btn-sm`          |
| language control        | package `Combobox` trigger, `--el-text-secondary` glyph                 | `--radius-input`, `--height-control`       |
| user initial            | `--el-tint-sky` fill, `--el-text-strong` letter, aria-hidden            | `rounded-full` 28 px                       |
| hero ground · H1 · lede | `--el-surface` · `--el-text` · `--el-accent-on-surface` (as MOTIR-8250) | serif 96 / 56 compact; lede `max-w-[62ch]` |
| waves                   | `--el-showcase-wave-1..3`, aria-hidden                                  | 1 px strokes                               |
| work band               | `--el-page-bg`, `border-t --el-border`                                  | `px-[38px] py-[48px]`                      |
| eyebrow                 | `--el-text-secondary`                                                   | mono 11 uppercase                          |
| step heading · body     | `--el-text` · `--el-text-secondary`                                     | serif 34 · 15                              |
| panel card              | `Card` (`--el-card-bg`, `--el-border`)                                  | `--radius-card`, `--spacing-card-padding`  |
| error alert             | `--el-tint-rose`, `--el-danger-on-surface` title                        | `--radius-card`                            |
| focus ring              | `--el-accent-on-surface`                                                | `ring-2`                                   |

### Slot → key

| slot                                        | key                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| hero H1 · lede                              | `onboardingMigrate.hero.headline` · `onboardingMigrate.hero.lede`                   |
| flow name                                   | `onboardingMigrate.brandBar.flowName`                                               |
| planAi                                      | `onboardingMigrate.brandBar.planAi`                                                 |
| Save & exit                                 | `onboardingMigrate.common.saveExit`                                                 |
| language trigger · pending · failed · retry | `auth.language.{label,switching,failed,retry}` + the `localeLabel` endonyms         |
| step eyebrow · heading · body · cta         | `onboardingMigrate.{start,connect,index,import,decision,resume}.*` (unchanged keys) |
| rail                                        | `onboardingMigrate.rail.*` (unchanged keys)                                         |
| error                                       | `onboardingMigrate.common.error`                                                    |
| access-path door (Panel 0)                  | `onboarding.entrance.{importTitle,importDesc,importCta}`                            |

Fixtures (the project name, repository names, counts) are illustrative data, not product copy.

### Findings

- **F1 — the shipped wizard paints its captions in `--el-text-muted`** (14 sites in
  `MigrateWizard.tsx`, among them the bar's `·` separator at line 229 and the panel notes at 510,
  543, 677, 679, 719). On today's white page and card that is 4.54:1 and passes with 0.04 to spare;
  the bar now sits on the hero's `--el-surface`, where muted is 4.17:1 and fails. The mock draws the
  separator, the flow name and every caption in `--el-text-secondary` (6.24:1 on `--el-surface`), and
  MOTIR-8254 should do the same rather than move muted ink onto the new ground.
- **F2 — the package `Button`'s `secondary` and `ghost` hover fill is `--el-surface`**, which is the
  hero's own ground, so the hover is invisible in this bar. The mock overrides hover to
  `--el-page-bg` (planAi also raises its border to `--el-border-strong`), drawn in Panel 9a. It is a
  local override; whether the package should grow an on-surface hover is a question for the design
  system, not this card.
- **F3 — the Decision panel's planNow glyph** is also taken; the card's criteria named only the bar.
- **F4 — MOTIR-8286's premise** says the wizard renders `OnboardingTopBar`; it does not, it has its
  own `BrandBar`. This design gives the wizard's bar its own trailing language control, at the same
  place in the order as MOTIR-8250's.

### Chinese-length risks (for MOTIR-8249 / MOTIR-8258)

The 96 px H1 (wraps to three lines at 1280 if the string is long — the compact 56 px step hero is
safer); the flow name in the bar (truncates with an ellipsis on narrow, row 2); the planAi label
(`secondary sm` has no max width — on narrow it takes its own row 3, so it may wrap there).

### Narrow (390)

The bar becomes three rows: lockup … language · initial; then the flow name; then planAi … Save &
exit. The full hero's H1 is 48 px, the compact one 34 px. The rail collapses above the panel as it
does today.

### GIVES / TAKES

- **TAKES** the lavender AI-glyph tile and the word "Motir" from `BrandBar`, the AI glyph from the
  planAi link and from the Decision panel's planNow button.
- **GIVES MOTIR-8254** the build of this frame: the bar, the full/compact hero, the work band, the
  `StepHead` restyle, the caption ink (F1), the hover override (F2).
- **GIVES MOTIR-8252** nothing beyond the primitives it already owns — the compact hero is a variant
  prop of `OnboardingHero`, and the work band is `OnboardingSection`'s band with no head.
- **GIVES MOTIR-8241** (GitHub connect) and **MOTIR-8246** (non-blocking index) the restyled frame
  their panels sit in; their content is theirs — except the Connect panel's four detection states,
  which Revision 1 below draws and MOTIR-8241 builds on.
- **GIVES MOTIR-8286** the language control in this bar (rest, open, pending, failed — Panel 9b).
- **GIVES MOTIR-8256** the pairs to gate: secondary on `--el-surface`, the hover override, the
  focus ring on `--el-surface`; **MOTIR-8249 / MOTIR-8258** the CJK risks above; **MOTIR-8257** the
  E2E context — the route and the step order are unchanged; the Connect keys change per Revision 1 below.
- **Premises taken from** MOTIR-930, MOTIR-4759, MOTIR-4766, MOTIR-8248 and MOTIR-8250.

### Revision 1 (2026-10-12) — the connect step detects GitHub by itself

**The reviewer's note, verbatim (on the published design):** _"Can the github connected status be
auto detected? that's the confusing part. check how other application do that"_

**What was confusing.** The shipped `ConnectPanel` (`MigrateWizard.tsx`) asks the person to report
on themselves: a link to `/settings/organization/git`, the GitLab note, and a Next labelled
`connect.next` ("I've connected my repos"). Press it with nothing connected and the advance 409s
(`CONNECT.checkExit` finds no repo set) and the wizard only `router.refresh()`es, so **nothing
visible happens**. The server already knows the answer, so the person should never have to tell it.

**Detection needs no new data source.** `CONNECT.checkExit` in `lib/services/migrateOnboardingService.ts`
reads `resolveWorkspaceConnectedRepos`, and `getIndexStatus`
(`GET /api/onboarding/migrate/[id]/index-status`, which the Index step already polls every 3 s)
returns that same set as `repos: MigrateIndexRepoDto[]` (`provider`, `repoRef`), empty when nothing
is connected. The Connect panel reads that route; `repos.length > 0` is "connected".

#### How other products do it (research)

| product                    | what it does                                                                                                                                                                                                                      | source                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel                     | The import screen lists the repositories the GitHub App can reach. A missing one is fixed through "Configure GitHub App"; you come back to the import screen and the repository appears. No confirm step anywhere.                | https://vercel.com/kb/guide/unable-to-find-github-repository                                                                                                                                                                                   |
| Netlify                    | Choosing GitHub prompts the app install only if it is not already installed; otherwise the repo list shows at once. "Configure the Netlify app on GitHub" sits under the list for adding access.                                  | https://docs.netlify.com/github-permissions/ · https://answers.netlify.com/t/no-longer-able-to-link-with-github-repositories/73357                                                                                                             |
| Render                     | Connecting sends you to GitHub and back to the dashboard with your repository list; a missing repository points to the app's Repository access settings.                                                                          | https://render.com/docs/github · https://render.com/docs/git-provider                                                                                                                                                                          |
| Codecov                    | After sign-up "you will be brought to a page with a list of repositories"; "it may take a few moments for your repositories to sync"; non-admins may need an org admin to approve.                                                | https://docs.codecov.com/docs/github-2-getting-a-codecov-account-and-uploading-coverage                                                                                                                                                        |
| CircleCI                   | Moved its GitHub App install to a redirect that lands on a loading screen, then "users will be automatically redirected to continue with their setup".                                                                            | https://circleci.com/changelog/minor-modification-to-github-app-installation-flow                                                                                                                                                              |
| Sentry · Linear            | The install starts from the product's own settings (Sentry: "begin the installation from Sentry"); GitHub returns to it and the integration shows as installed, with an org owner needed for org-wide access.                     | https://docs.sentry.io/organization/integrations/source-code-mgmt/github/ · https://linear.app/docs/github-integration                                                                                                                         |
| GitHub (the platform)      | After an install GitHub redirects to the app's **Setup URL** with `installation_id`, and optionally again when the installation is **updated** (repos added or removed). The id must not be trusted alone; verify it server-side. | https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url                                                                                                                                              |
| Popup hand-backs (caution) | `window.opener.postMessage` from a popup is unreliable: `opener` comes back null under extensions and desktop shells, and popups get stranded. Teams fall back to a server-side callback or a re-read.                            | https://forum.asana.com/t/app-installation-callback-failures/235883 · https://community.shopify.dev/t/shopify-oauth-popup-cannot-auto-close-after-successful-install-when-initiated-from-admin-shopify-com-admin-shell-reclaiming-window/28862 |
| The browser                | `visibilitychange` fires when the person switches tabs or comes back to one, the hook for "re-check when you return".                                                                                                             | https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event                                                                                                                                                               |

**The common pattern:** (1) no product asks the person to say they have connected; the screen
**reads** the connection and shows it; (2) the screen shows the **detected account / repository
list**, which doubles as the confirmation and as the "is the right repo in there?" check; (3) a
quiet **"configure / adjust access on GitHub"** link stays next to the list; (4) the return trip is
a **server-side callback** (the Setup URL) as the authority, with a **re-read on return** (focus /
visibility) and a short **poll while waiting** as the fallback, never a popup message alone.
Motir takes (1)–(3) now and the re-read half of (4). The callback half is MOTIR-8241's (below).

#### The four states (Panels 2a–2d, light and dark; narrow 2b and 2d in Panel 11)

Every state keeps the compact hero, the rail (Connect current), the eyebrow, heading and body. The
card is the package `Card` (`--el-card-bg`, `--el-border`, `--radius-card`,
`--spacing-card-padding`). In 2a–2c its body holds one minimum height (`min-h-[148px]`), so the
swaps between them happen in place; only 2d grows, with its list. Each state's status line and hint
sit in one `role="status"` region, so the change is announced politely.

| state                      | element                                   | colour role                                                               | shape / size                                                  |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **a · Checking**           | spinner (aria-hidden wrapper)             | `--el-accent-on-surface`                                                  | `Spinner sm` (`rounded-full`)                                 |
|                            | "Checking for connected repositories…"    | `--el-text-secondary` on the card                                         | 14 px                                                         |
|                            | (no control)                              | —                                                                         | —                                                             |
| **b · Not connected yet**  | glyph `GitBranch` (aria-hidden)           | `--el-text-secondary`                                                     | 16 px                                                         |
|                            | title "No repositories connected yet"     | `--el-text`, semibold                                                     | 14 px                                                         |
|                            | hint (one line: Motir notices by itself)  | `--el-text-secondary`                                                     | 14 px, `max-w-[60ch]`                                         |
|                            | **Connect GitHub ↗** (new tab)            | `Button primary md` (`--el-accent` / `--el-accent-text`)                  | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x/y`, w-fit |
|                            | sr-only "(opens in a new tab)"            | —                                                                         | —                                                             |
|                            | GitLab note                               | `--el-text-secondary` (F1)                                                | 12 px                                                         |
| **c · Waiting for GitHub** | spinner (aria-hidden wrapper)             | `--el-accent-on-surface`                                                  | `Spinner sm`                                                  |
|                            | title "Waiting for GitHub" · hint         | `--el-text` semibold · `--el-text-secondary`                              | 14 px                                                         |
|                            | **Open GitHub settings again ↗**          | `Button secondary md` (`--el-border`, `--el-text`)                        | `--radius-btn`, `--height-btn-md`, w-fit                      |
|                            | GitLab note                               | `--el-text-secondary`                                                     | 12 px                                                         |
| **d · Connected**          | glyph `CheckCircle2` (aria-hidden)        | `--el-success` (a graphic on the card, ≥ 3:1 since MOTIR-3991)            | 16 px                                                         |
|                            | "3 repositories are connected"            | `--el-text`, semibold — the hue is in the glyph, never the label          | 14 px                                                         |
|                            | hint                                      | `--el-text-secondary`                                                     | 14 px                                                         |
|                            | repo row (`owner/name`, mono)             | border `--el-border-soft`; owner `--el-text-secondary`, name `--el-text`  | `--radius-control`, `--spacing-control-x`, py-2.5, mono 13    |
|                            | row tick `Check` (aria-hidden)            | `--el-success`                                                            | 16 px                                                         |
|                            | Manage repositories on GitHub ↗ (new tab) | `--el-text-secondary`, underlined; focus outline `--el-accent-on-surface` | `--radius-control` (focus box)                                |
|                            | **Continue →**                            | `Button primary md`                                                       | `--radius-btn`, `--height-btn-md`; `ml-auto` (trailing edge)  |

"Connected" covers both cases: just connected (from 2c) and already connected on arrival (2a →
2d directly, with no 2b in between). No `--el-text-muted` sits on a tint or `--el-surface`, no
`--el-text-faint` carries text, no `--el-danger-text` appears, and nothing is a raw colour.

#### The detection mechanism (for MOTIR-8254)

1. **Read on mount.** The panel fetches `GET /api/onboarding/migrate/[id]/index-status` (the same
   route and DTO the Index step polls) and shows 2a until it answers: `repos.length > 0` → 2d,
   otherwise → 2b.
2. **Re-read on return.** While the panel is mounted and not in 2d, a `focus` on `window` and a
   `visibilitychange` to `visible` each trigger one read (de-duplicated: one in flight at a time,
   seq-guarded so an older answer never overwrites a newer one).
3. **Poll only while waiting.** Pressing Connect GitHub (or Open GitHub settings again) moves the
   panel to 2c and starts a ~5 s poll. It stops on the first non-empty answer (→ 2d) or when the
   person leaves the step (unmount). 2b does not poll; it re-reads on return only.
4. **A failed read** shows the existing error alert (Panel 7, drawn over 2b) and keeps the state
   it had; the next focus or poll retries it. No new error copy.
5. **Continue** calls the existing advance (`connect` → `index`). It is drawn only in 2d, so it is
   pressed only when `checkExit` will pass — **Next is never a silent no-op any more.** If the set
   empties between the read and the press (someone removed access), the 409 now lands the panel back
   on 2b through a re-read, not on a bare `router.refresh()`.

#### Slot → key (Revision 1)

All copy is proposed for `onboardingMigrate.connect.*`; `messages/` is **not** edited here
(MOTIR-8254 adds the keys and their ten translations).

| slot                                | key                            | status      | English                                                                                                      |
| ----------------------------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| eyebrow · heading                   | `connect.eyebrow` · `.heading` | unchanged   | (as shipped)                                                                                                 |
| body                                | `connect.body`                 | **CHANGED** | Motir reads the repositories you connect on GitHub and builds one map of the code across the project.        |
| 2a status                           | `connect.checking`             | **NEW**     | Checking for connected repositories…                                                                         |
| 2b title                            | `connect.missingTitle`         | **NEW**     | No repositories connected yet                                                                                |
| 2b hint                             | `connect.missingHint`          | **NEW**     | Connect GitHub in a new tab. Motir notices the connection by itself, so there is nothing to confirm here.    |
| 2b primary                          | `connect.connectCta`           | **NEW**     | Connect GitHub                                                                                               |
| sr-only after every new-tab control | `connect.newTab`               | **NEW**     | (opens in a new tab)                                                                                         |
| 2c title                            | `connect.waitingTitle`         | **NEW**     | Waiting for GitHub                                                                                           |
| 2c hint                             | `connect.waitingHint`          | **NEW**     | Finish connecting in the other tab. Motir checks again when you come back, and every few seconds until then. |
| 2c secondary                        | `connect.reopenCta`            | **NEW**     | Open GitHub settings again                                                                                   |
| 2d success line                     | `connect.detected`             | **NEW**     | `{count, plural, one {# repository is connected} other {# repositories are connected}}`                      |
| 2d hint                             | `connect.detectedHint`         | **NEW**     | These are the repositories Motir can read. Indexing starts when you continue.                                |
| 2d list `aria-label`                | `connect.listLabel`            | **NEW**     | Connected repositories                                                                                       |
| 2d primary                          | `connect.continue`             | **NEW**     | Continue                                                                                                     |
| 2d quiet link                       | `connect.manage`               | **NEW**     | Manage repositories on GitHub                                                                                |
| GitLab note                         | `connect.gitlabNote`           | unchanged   | GitLab connect is coming soon.                                                                               |
| —                                   | `connect.next`                 | **DELETE**  | ("I've connected my repos" — no longer read)                                                                 |
| —                                   | `connect.cta`                  | **DELETE**  | ("Open GitHub settings" — replaced by `connectCta` / `reopenCta`)                                            |

`connect.body` changes because the shipped one says "workspace settings" (the connect surface is
organisation-tier since MOTIR-4680) and names an internal seam ("the GitProvider seam"). Repository
names on the board (`acme/web`, `acme/api`, `acme/infra`) are fixtures.

#### GIVES / LEAVES

- **GIVES MOTIR-8254** these four states, the detection mechanism above and the key table. Its
  acceptance criterion that the **connect flow is unchanged is amended by this revision**: the
  Connect panel's controls and copy change as drawn here; the route, the step order and the advance
  call stay.
- **LEAVES MOTIR-8241** the full GitHub round trip: starting the install from onboarding with its
  own signed state, the Setup-URL return to **this** step instead of to Settings, and the
  install-cancelled, no-repositories-selected, waiting-for-an-org-owner and error states. It draws
  them **on top of** 2a–2d (the callback lands on 2a, which reads and resolves as above), and the
  re-read and poll here stay as its fallback.
- **GIVES MOTIR-8256** the new pairs to gate: `--el-success` glyph on `--el-card-bg` in both
  themes; `--el-text-secondary` link and hint on the card; and **MOTIR-8257** the new E2E surface
  (Continue appears only after detection; the Connect GitHub link has `target="_blank"`).

### Revision 2 (2026-10-12) — the code index never holds onboarding

Published as evidence `cmv53f83v00yqhyshnxkzzqq9` (commit `478dc22`) and republished from the commit
that adds this line; it supersedes Revision 1's `cmv527yiv00qlhxoi3hiys1q2`.

**The reviewer's note, verbatim (on Revision 1):** _"The user should not be blocked on the index
step. the index can take a long time, the user should be go forward. the index only blocks
planning, not onboarding"_

**What was wrong.** Revision 1 kept Panel 3 "as it ships today": after Connect the person landed on
an Index screen whose only job was to wait (spinner, per-repo list, a disabled Next, and a callout
saying Next stays disabled until every repository finishes). On a large codebase that is minutes of
watching a bar, and a failed index never ends it (`INDEX.checkExit` and `runIndexSweep` only look
for a _succeeded_ index).

**Why this is a redraw and not a replan.** The behaviour the note asks for is already planned, in
detail, by the sibling story **MOTIR-8246** ("Onboarding moves on while the code index builds"):
the `index` exit becomes "an index exists in any state", generation waits in the background through
a widened `runIndexSweep`, the convention is derived once the graph exists, MOTIR-933's "no plan
from unread code" stands, and a failure undoes nothing. MOTIR-8246 owes a design subtask that draws
those states "in the restyled onboarding look". This revision draws them now, in this frame, so the
reviewer decides the restyle and the non-blocking index together, and MOTIR-8246's design work
composes these panels instead of starting over. No card's scope moves: the **build** stays with
MOTIR-8246 (it needs service, sweep and generate changes no restyle card owns).

#### What changes on the board

| panel    | before (Revision 1)                       | now                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2d       | Continue → Index                          | Continue → **Import** directly. The hint says reading starts and the person will not have to wait.                                                                                                                                   |
| 3        | Index — the waiting screen, Next disabled | **Removed.** There is no Index panel.                                                                                                                                                                                                |
| 3a (new) | —                                         | Import, arrived straight from Connect: the **indexing chip** in the bar reads _Reading your code · 33%_; the rail's Index row is a **background row**.                                                                               |
| 3b (new) | —                                         | The chip opened: a popover with what the old Index panel showed (aggregate line, bar, per-repository rows), plus one line saying only drafting the plan waits.                                                                       |
| 3c (new) | —                                         | Reading failed, surfaced on whatever step the person reached (drawn on Decision): chip and rail in the failed state, the detail naming the repository, **Try again** and **Check the connection**.                                   |
| 4        | Import                                    | Import at the moment reading finishes: the chip says _Your code is read_, announced once, then leaves the bar; the rail's Index row becomes an ordinary done row.                                                                    |
| 5        | Decision                                  | Decision while reading still runs: both buttons stay enabled; a sky-tint note says the plan is drafted as soon as reading finishes and the person is told. With reading done the note is absent (as before). Failed: a sibling note. |
| 9c (new) | —                                         | The chip's five looks: queued · reading · focus-visible · read · failed.                                                                                                                                                             |
| 10       | Narrow — Start and Index                  | Narrow — Start, and Import with the chip (closed, then opened: the detail drops full-width under the hero instead of floating).                                                                                                      |

#### The indexing chip and its detail — per element

| element                                                            | colour role                                                                                                                                                                                   | shape / size                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| chip (a `button`, `aria-expanded`, `aria-controls="index-detail"`) | `Button secondary sm` on `--el-page-bg`; label `--el-text`                                                                                                                                    | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x/y-sm`                               |
| chip glyph — queued / reading                                      | `Spinner sm`, `--el-accent-on-surface` (aria-hidden)                                                                                                                                          | `rounded-full`                                                                          |
| chip glyph — read                                                  | `CheckCircle2`, `--el-success` (a graphic, ≥ 3:1)                                                                                                                                             | 14 px                                                                                   |
| chip — failed                                                      | border `--el-danger`, glyph `CircleAlert` `--el-danger-on-surface`; label stays `--el-text`                                                                                                   | as above                                                                                |
| chip label                                                         | inside an `aria-live="polite"` span, so a state change is announced, never focused                                                                                                            | 12–13 px                                                                                |
| chip focus-visible                                                 | `--focus-ring-color` ring, offset on `--el-surface`                                                                                                                                           | ring-2                                                                                  |
| detail popover (`role="dialog"`, `data-surface="popover"`)         | `--el-page-bg`, border `--el-border`, `--shadow-elevated`                                                                                                                                     | `--radius-card`, `--spacing-card-padding`; 380 px, full-width at 390                    |
| title · Close                                                      | `--el-text` semibold · `Button ghost sm`                                                                                                                                                      | —                                                                                       |
| body / failed body · aggregate line                                | `--el-text-secondary` on `--el-page-bg`                                                                                                                                                       | 14 px · 12 px                                                                           |
| progress bar                                                       | track `--el-muted`, fill `--el-accent`                                                                                                                                                        | `rounded-full`, 6 px                                                                    |
| repo rows                                                          | border `--el-border-soft`; owner `--el-text-secondary`, name `--el-text`, mono; chips as shipped (`--el-tint-mint` + `--el-text-strong` indexed, `--el-muted` + `--el-text-secondary` queued) | `--radius-control`, `--spacing-control-x`; chips `--radius-badge`, `--spacing-chip-x/y` |
| failed row                                                         | border `--el-danger`; glyph and "Could not read the code" `--el-danger-on-surface`                                                                                                            | as above                                                                                |
| Try again · Check the connection                                   | `Button primary sm` with `RotateCcw` · `Button ghost sm` → `/settings/organization/git`                                                                                                       | `--radius-btn`, `--height-btn-sm`                                                       |
| rail background row — marker                                       | reading: `Spinner sm` in a `--el-border` ring, `--el-accent-on-surface`; failed: `CircleAlert` `--el-danger-on-surface`                                                                       | `size-5`, `rounded-full`                                                                |
| rail background row — label · meta                                 | `--el-text` · `--el-text-secondary` (12 px). Never `aria-current`; the current step stays the step the person is on.                                                                          | `--radius-control`, `--spacing-control-x`                                               |
| Decision note (reading / failed)                                   | `--el-tint-sky` with `--el-text-strong`; `Spinner sm` / `CircleAlert` glyph                                                                                                                   | `--radius-card`, `--spacing-card-padding`                                               |

No `--el-text-muted` on a surface or tint, no `--el-text-faint` text, no `--el-danger-text`, no raw
colour. Chip placement: first in the bar's control group (before _Start from an idea instead_); at
390 px it takes the flow-name row's trailing edge.

#### Behaviour the board depicts (built by MOTIR-8246, not by MOTIR-8254)

1. **Connect → Import.** The `index` exit becomes "an index exists for this run's repository in
   any state", so the advance from Connect passes straight through (MOTIR-8246 §1). The rail keeps
   its Index row; it is never the current step.
2. **One read, two places.** The chip and the rail row read the same
   `GET /api/onboarding/migrate/[id]/index-status` the old panel polled, on the same cadence, for the
   rest of onboarding; it stops once every repository is indexed (the chip shows _read_ for a few
   seconds, then leaves).
3. **Opening the detail changes nothing.** The popover closes on Close, Escape or an outside click
   and returns focus to the chip; the step underneath is never re-rendered or advanced.
4. **The plan waits, the person does not.** Plan my project now and Finish later stay enabled;
   generation is started by the widened sweep when the graph succeeds (MOTIR-8246 §3). This board
   draws only the Decision note; the discovery canvas's own "your plan will be drafted when
   indexing finishes" state and the "your plan is ready" notice are MOTIR-8246's to draw in the
   ai-chat frame (`design/ai-chat/onboarding--vibe-lockup.mock.html`).
5. **Failure undoes nothing.** Every completed step stays done; Try again uses the index's existing
   re-enqueue (MOTIR-8246 §4 and its HOW 5); Check the connection opens the git settings.

#### Slot → key (Revision 2, proposed — `messages/` is not edited here)

| slot                                         | key                                                                                                                           | status                                                                        | English                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rail sub-line                                | `rail.sub`                                                                                                                    | **CHANGED**                                                                   | Reading your code runs in the background. Nothing here waits for it.                                                                                                                                                                                     |
| rail Index meta (reading)                    | `rail.indexBackground`                                                                                                        | **NEW**                                                                       | In the background · {pct}%                                                                                                                                                                                                                               |
| rail Index meta (queued)                     | `rail.indexQueued`                                                                                                            | **NEW**                                                                       | In the background · queued                                                                                                                                                                                                                               |
| rail Index meta / failed row                 | `rail.indexFailed`                                                                                                            | **NEW**                                                                       | Could not read the code                                                                                                                                                                                                                                  |
| chip — queued · reading · read · failed      | `indexing.queued` · `.running` · `.done` · `.failed`                                                                          | **NEW**                                                                       | Queued to read your code · Reading your code · {pct}% · Your code is read · Could not read your code                                                                                                                                                     |
| detail title · Close                         | `indexing.detailTitle` · `.close`                                                                                             | **NEW**                                                                       | Reading your code · Close                                                                                                                                                                                                                                |
| detail body                                  | `indexing.detailBody`                                                                                                         | **NEW**                                                                       | This runs in the background, so keep going. Only drafting your plan waits for it, and it starts by itself when reading finishes.                                                                                                                         |
| detail failed body                           | `indexing.failedBody`                                                                                                         | **NEW**                                                                       | Motir could not read {repo}. Nothing you have done is lost. Your plan waits until the code can be read.                                                                                                                                                  |
| failed actions                               | `indexing.retry` · `.checkConnection`                                                                                         | **NEW**                                                                       | Try again · Check the connection                                                                                                                                                                                                                         |
| Decision note — reading · failed             | `decision.waitNote` · `.failedNote`                                                                                           | **NEW**                                                                       | Motir is still reading your code. Pick either one now: your plan is drafted as soon as reading finishes, and you are told when it is ready. · Motir could not read your code yet. Either choice is safe: your plan is drafted once the code can be read. |
| 2d hint                                      | `connect.detectedHint`                                                                                                        | **CHANGED** (vs Revision 1)                                                   | Motir starts reading their code as soon as you continue. You will not have to wait for it.                                                                                                                                                               |
| detail aggregate · per-repo head · row chips | `index.aggregate` · `index.perRepo` · `index.state.*`                                                                         | unchanged, re-used                                                            | (as shipped)                                                                                                                                                                                                                                             |
| —                                            | `index.eyebrow` · `.heading` · `.body` · `.building` · `.callout` · `.next` · `.waiting` · `.completeTitle` · `.completeNote` | **RETIRED with the panel** (MOTIR-8246 deletes them when it removes the stop) | —                                                                                                                                                                                                                                                        |

**Chinese-length risk (MOTIR-8249 / MOTIR-8258):** the chip label is the bar's longest new slot;
it must fit `--height-btn-sm` on one line at 1280 px beside _Start from an idea instead_. At 390 px
it shares the flow-name row, which truncates the flow name first, never the chip.

#### GIVES / TAKES (Revision 2)

- **TAKES** the Index panel (Panel 3 of Revision 1 and of MOTIR-930's record) and its disabled Next.
- **GIVES MOTIR-8246** the chip, the detail, the background rail row, the failed state and the
  Decision note as its drawn surfaces, and their build. Its owed design subtask composes these
  panels and adds only the canvas-side states (plan waiting, plan ready). Comment posted there.
- **GIVES MOTIR-8254** nothing new to build: it restyles the frame as Revision 1 said; until
  MOTIR-8246 lands, the shipped Index stop keeps working in the restyled frame, and its acceptance
  is unchanged by this revision.
- **GIVES MOTIR-8256** the new pairs to gate: `--el-danger` border + `--el-danger-on-surface` glyph
  on `--el-page-bg`, `--el-text-strong` on `--el-tint-sky`; **MOTIR-8257** nothing (the E2E walks
  the shipped stop until MOTIR-8246).

### Revision 3 (2026-10-12) — no Start panel when the only project is the sign-up default

**The reviewer's note, verbatim (on Revision 2):** _"When there is only the default project, don't
need to show the project. The user didn't create the project, and it's the only project available,
go to connect step directly"_

**What was wrong.** The shipped wizard renders `StartPanel` whenever the project has no run
(`run === null` in `MigrateWizard.tsx`): a card naming the active project and a Start button that
POSTs `/api/onboarding/migrate`. For a new sign-up the workspace holds one project, the one Motir
created for them, so the card asks them to confirm a choice they never made and could not make
differently. (The importer already skips its picker in this case: `loadImportWizard` in
`app/(onboarding)/onboarding/import/_data.ts` falls through to the first project when no
`projectId` is given and shows the picker only for an empty or a bad request, so the importer is
unchanged by this revision.)

**What the board now draws.**

| panel | before (Revision 2)                     | now                                                                                                                                               |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a    | —                                       | **Arrival with only the default project**: no Start panel; the wizard opens on **Connect** (2a → 2b/2d) under the **full** hero, rail on Connect. |
| 1b    | Start (the arrival screen for everyone) | Start, **only when the workspace has two or more projects**, unchanged in look and copy.                                                          |
| 10    | Narrow — Start and Import               | Narrow — the 1a arrival on Connect, and Import with the indexing chip.                                                                            |

**The hero rule changes from "full on Start" to "full on a run's first screen"** — Start (1b) or
Connect (1a) — and compact after any step advance. Measured on the board at 1280 px, the 1a Connect
card's action still sits above a laptop fold (its Connect GitHub button lands about 700 px down the
frame, inside an 800 px laptop viewport); no new token, no new string.

**Behaviour (for MOTIR-8254).**

1. **The condition is the workspace's project count**, read on the server by the migrate page:
   `run === null` and exactly one project in the workspace → the island receives `autoStart`.
   Schema has no "created at sign-up" flag, and none is needed: a one-project workspace has nothing
   to choose, whoever created the project.
2. **The island starts the run on mount** with the same `startRun` call (so the MOTIR-4759 kept set
   still rides the START call from the query), and renders Connect's 2a Checking state while the
   POST and the first read are in flight; the result lands on 2b or 2d in place. No Start panel
   is ever painted, so there is no flash.
3. **A failed start** shows the existing error alert above the Start panel (1b's panel, as the
   retry), never a dead Connect panel. A 409 (a run already exists) refreshes, as today.
4. **Two or more projects** → exactly today's Start (1b).

Copy: nothing new; Start's keys stay for 1b.

#### GIVES / TAKES (Revision 3)

- **TAKES** the Start panel from the one-project arrival.
- **GIVES MOTIR-8254** the `autoStart` arrival above (one server read of the project count, one
  mount effect, the fallback); its "every step unchanged" criterion is amended for Start exactly
  as Revision 1 amended it for Connect. Comment posted there.
- **GIVES MOTIR-8257** the E2E change: a fresh sign-up on `/onboarding/migrate` sees Connect, not
  Start; a two-project workspace still sees Start.
- **MOTIR-8246 and Revision 2 are unaffected.**

### Revision 4 (2026-10-12) — Start is a project choice, and the wizard turns warm

**The reviewer's notes, verbatim (on Revision 3):** _"screen 1b is still showing the single
project, what did you do?"_ and _"make the UI more colorful, use the warm color, the orange and the
yellow we added to the color palette"_

**What was wrong with 1b.** Revision 3 kept Start for a workspace with two or more projects but
drew it exactly as before: one card naming the open project and a Start button. With nothing else
on the screen it read as the single-project Start that Revision 3 removed, and it gave a person who
does have several projects no way to say which one they mean. Start now exists only when there is
something to choose, so it is drawn as the choice.

**1b, per element.**

| element                                            | primitive / markup                       | colour                                                                                                | shape                                             |
| -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| legend "Which project are you migrating?"          | `fieldset` + `legend`                    | `--el-text`                                                                                           | —                                                 |
| one row per project in the workspace (fixtures: 3) | `label` wrapping a native `radio`        | border `--el-border`, fill `--el-page-bg`; hover border `--el-border-strong`                          | `--radius-card`, `--spacing-card-padding` × 12 px |
| the picked row (the open project, pre-selected)    | same, `checked`                          | fill `--el-tint-yellow`, border + 1 px ring `--el-highlight` (3.34:1 on the tint, light; 4.34:1 dark) | same                                              |
| radio                                              | native                                   | —                                                                                                     | 16 px                                             |
| project key tile                                   | `span`, mono key                         | `--el-text-strong` on the next tint in peach → yellow → rose                                          | `--radius-control`, 36 px                         |
| name · meta                                        | text                                     | `--el-text` · `--el-text-secondary` (5.93:1 on yellow, 5.36:1 on peach)                               | —                                                 |
| "Open now" chip on the open project                | chip                                     | `--el-tint-peach`, `--el-text-strong`                                                                 | `--radius-badge`, `--spacing-chip-x/y`            |
| CTA "Start with {project}"                         | `Button` primary md, trailing ArrowRight | the ink CTA, unchanged                                                                                | `--radius-btn`                                    |

**Behaviour (for MOTIR-8254).** The page passes the workspace's projects with the active one
marked. Picking the open project and pressing Start is today's `startRun`. Picking another project
first switches the active project with the existing `setActiveProjectAction` (the sidebar's
ProjectSwitcher path), then starts the run for it; the CTA's name follows the pick. Revision 3's
point 4 ("two or more projects → exactly today's Start") is replaced by this; its points 1 to 3 stand,
and a failed start shows the error alert above this panel.

**Proposed copy** (in the board's `NEW` map; `messages/` is not edited here):

| key                                   | English                               |
| ------------------------------------- | ------------------------------------- |
| `onboardingMigrate.start.chooseLabel` | Which project are you migrating?      |
| `onboardingMigrate.start.current`     | Open now                              |
| `onboardingMigrate.start.currentMeta` | The project you have open             |
| `onboardingMigrate.start.otherMeta`   | Switches to this project, then starts |
| `onboardingMigrate.start.ctaFor`      | Start with {project}                  |

`start.projectLine` and `start.cta` retire with the single-project card.

**The warm pass — the motir palette's warm touches (design-system §8, MOTIR-7583).** The orange is
`--el-highlight` / `--el-progress-fill` (`#d66000` light, `#fa5500` dark) and the yellow is
`--el-tint-yellow` (with `--el-tint-peach` beside it); the citrine gold is `--el-type-design`. All
are DECORATIVE roles, so the orange is used only for fills, rings, borders and glyphs, never for
text; every label stays on the ink tokens. It applies to all three boards (this one, the importer
and discovery), since they share the bar and hero.

| element                                      | before                                    | now                                                                                                                            |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| hero background                              | `--el-surface`                            | `--el-hero-glow`: a peach glow top-left and a yellow glow bottom-right over `--el-surface-soft` (light), the dark tints (dark) |
| hero waves                                   | the three `--el-showcase-wave-*` hues     | `--el-hero-wave-1/2/3` → orange, citrine, orange, at a slightly higher alpha                                                   |
| hero lede                                    | `--el-accent-on-surface` (blue)           | `--el-text-strong` (AA on every glow stop)                                                                                     |
| step eyebrow                                 | text only                                 | an 8 px `--el-highlight` dot before it (`aria-hidden`)                                                                         |
| rail: current step                           | `--el-surface` row, blue ring, ink marker | `--el-tint-yellow` row, `--el-highlight` ring, `--el-highlight` marker with a 22 % halo                                        |
| rail: background Index marker, spinners      | `--el-accent-on-surface`                  | `--el-highlight`                                                                                                               |
| Connect card                                 | plain card                                | `Card` tint by state: checking yellow, not connected peach, connected mint                                                     |
| progress bars                                | ink fill on `--el-muted`                  | `--el-progress-fill` on `--el-tint-yellow`                                                                                     |
| info callout, answered-steps marker          | `--el-tint-sky`                           | `--el-tint-yellow`, `--el-tint-peach`                                                                                          |
| avatar initial                               | `--el-tint-sky`                           | `--el-tint-peach`                                                                                                              |
| importer: current step marker                | ink fill, white number                    | `--el-tint-yellow` fill, `--el-text-strong` number, `--el-highlight` ring                                                      |
| importer: picked source card                 | ink border + ring                         | `--el-highlight` border + 22 % ring                                                                                            |
| discovery canvas: the "you are here" station | blue border + ring                        | `--el-highlight` border + ring                                                                                                 |

Measured pairs (WCAG): `--el-highlight` is 3.80:1 on the page, 3.34:1 on `--el-tint-yellow` and
3.01:1 on `--el-tint-peach` in light, and 4.34 / 4.53:1 on the dark tints, so every orange ring,
border and glyph clears the 3:1 non-text bar. Error, danger and success keep their own tokens.

**Four new Tier-3 roles** (withdrawn by Revision 5), declared in each board's own token block and proposed for
`packages/design-system/theme.css` (every input is a palette token, so a `data-palette` swap
re-tints them): `--el-hero-wave-1: var(--el-highlight)`, `--el-hero-wave-2: var(--el-type-design)`,
`--el-hero-wave-3: var(--el-highlight)`, and `--el-hero-glow` (the two radial gradients over
`--el-tint-peach` / `--el-tint-yellow` / `--el-surface-soft`).

#### GIVES / TAKES (Revision 4)

- **GIVES MOTIR-8254** the 1b project choice (the projects list, the switch-then-start path, the
  five keys), the warm pass on the migrate wizard and the importer, and the four hero roles in the
  design-system theme. The hero is the shared primitive MOTIR-8252 built, so the entrance and
  how-it-works (MOTIR-8250) warm with it; their layout and copy do not change.
- **GIVES MOTIR-8255** the warm pass on the discovery canvas's "you are here" station.
- **GIVES MOTIR-8256** the new orange and yellow pairs for its contrast run across every palette.
- **GIVES MOTIR-8257** the E2E change: a two-project workspace sees the project choice with the
  open project picked.
- **GIVES MOTIR-8258** the five new keys to translate.

### Revision 5 (2026-10-12) — warm on the button and the small things, the tone stays cool

**The reviewer's note, verbatim (on Revision 4):** _"use the warm colors for the button and small
things like progress bar. the overall tone should still be cool"_

**What changes.** Revision 4's warm pass went too far: it washed the hero and tinted whole rows and
cards. This revision takes the warm colour back off every surface and keeps it only on the
primary button and on small marks. Revision 4's 1b project choice stands, and so does its copy.
Where Revision 4's tables say otherwise, this section wins.

| element                                       | Revision 4                                           | now                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **primary button** (every board)              | the ink CTA                                          | **`--el-cta-warm` fill, `--el-cta-warm-text` label**: the warm orange, ink label                        |
| hero background, waves, lede                  | peach and yellow glow, warm waves, ink lede          | back to the shipped hero: `--el-surface`, `--el-showcase-wave-*`, `--el-accent-on-surface` lede         |
| step eyebrow dot                              | `--el-highlight`                                     | kept                                                                                                    |
| rail: current step                            | yellow row, orange ring                              | `--el-surface` row with the `--el-accent-on-surface` ring (cool); the **marker** stays `--el-highlight` |
| rail: background Index marker, spinners       | `--el-highlight`                                     | kept                                                                                                    |
| progress bars                                 | `--el-progress-fill` on `--el-tint-yellow`           | kept                                                                                                    |
| Connect card                                  | tinted by state                                      | plain `Card`                                                                                            |
| info callout · answered-steps marker · avatar | yellow · peach · peach                               | `--el-tint-sky` (as shipped)                                                                            |
| 1b picked row · key tiles · "Open now" chip   | yellow fill, orange ring · peach/yellow/rose · peach | `--el-surface` fill, `--el-accent-on-surface` border and ring · sky/lavender/mint · lavender            |
| importer: current step marker                 | yellow fill, orange ring                             | `--el-cta-warm` fill, `--el-cta-warm-text` number, 22 % halo (the same pair as the button)              |
| importer: picked source card                  | orange border                                        | the shipped ink border                                                                                  |
| discovery canvas: "you are here" station      | orange border                                        | the shipped `--el-accent-on-surface` border                                                             |

**The two new roles, replacing Revision 4's four hero roles** (which are withdrawn). Each board declares
them in its own token block, and the build adds them to `packages/design-system/theme.css`:

| role                 | light                             | dark                              | measured (WCAG)               |
| -------------------- | --------------------------------- | --------------------------------- | ----------------------------- |
| `--el-cta-warm`      | `var(--el-highlight)` (`#d66000`) | `var(--el-highlight)` (`#fa5500`) | —                             |
| `--el-cta-warm-text` | `var(--el-text)` (`#16191d`)      | `var(--el-page-bg)` (`#0c0d0f`)   | 4.65:1 light, 5.9:1 dark (AA) |

The label is dark in BOTH themes because white on the warm orange is 3.8:1 in light and 3.3:1 in
dark, both under AA. The button keeps `Button`'s primary shape, sizes and `hover:opacity-90`; only the
two colour roles change, so the build is a `warm` treatment of the primary variant (a className pair
or a variant), not a new component. Disabled keeps `Button`'s own disabled opacity.

#### GIVES / TAKES (Revision 5)

- **GIVES MOTIR-8254** the warm primary button on the migrate wizard and the importer, the two roles
  above in the design-system theme, and the importer's warm current-step marker. It **TAKES** back
  Revision 4's hero roles and its surface tints.
- **GIVES MOTIR-8255** the warm primary button on the discovery and direction-doc surfaces. The
  "you are here" station stays as shipped.
- **GIVES MOTIR-8256** the two new pairs for its contrast run across every palette.
- MOTIR-8257 and MOTIR-8258 are unchanged from Revision 4.

### Revision 6 (2026-10-12) — one page to finish onboarding

**The reviewer's note, verbatim (on Revision 5):** _"1. I don't see the design for "A few questions" 2. is design/ai-chat/onboarding--vibe-lockup.mock.html for "A few questions"? I don't see how we get
there. if it's not for "A few questions" the design doesn't show me how we get there 3. use some
yellow color from the palette too 4. don't send the user to a different page/tab for the importing
work items, the importer can be on the same page. one page to finish the onboarding"_

**What changes.** The migrate wizard becomes the one page a person finishes onboarding on. The
importer runs inside its Import step, and "A few questions" is a step of the same page, reached from
Decision. Nothing before the plan is ready leaves `/onboarding/migrate`. Revision 5's colour rules
stand; this revision adds the palette's yellow to small chips. Where earlier sections say otherwise
(Panel 4's Open the importer, Panel 5's hand-off to `/onboarding/discovery`, Panel 6's Resume link),
this section wins.

| panel | what it shows                                                                                                                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4a    | Import, with the importer IN the panel: the importer's own step rail (Connect · Map · Preview · Import) and its Connect step inside one `Card`. **Skip import** (ghost) takes the importer's Cancel slot. No link to `/onboarding/import`, no new tab |
| 4b    | a source connected: the vendor OAuth round trip returns to `/onboarding/migrate` on the Import step (`?jira=connected`), not to `/onboarding/import`                                                                                                  |
| 4c–4e | the importer's Map, Preview and Import-running steps, unchanged, in the same card                                                                                                                                                                     |
| 4f    | the importer's finished state, whose action is **Continue** (primary). It advances to Decision; the importer's View imported backlog is not offered here                                                                                              |
| 5     | Decision. **Plan my project now** advances to "A few questions" on this page; it no longer leaves for `/onboarding/discovery`                                                                                                                         |
| 6a    | **"A few questions"**, the screen the rail has always named: the rail's Your direction group marks it current. One conversation card: a yellow progress chip, the turns (the chat rail's bubbles and BrandMark avatar), the composer and Send         |
| 6b    | answered: the card becomes a status, Drafting your first plan (warm spinner, warm fill on the yellow track). While the code is still being read it says drafting starts by itself when reading finishes                                               |
| 6c    | the plan is ready: a mint check, the drafted count and **Review your plan** (primary), the one exit at the end of onboarding, to the plan's review page that `GenerationHandoff` opens today                                                          |
| 6d    | Resume: **Continue planning** resumes 6a in place instead of linking to `/onboarding/discovery`                                                                                                                                                       |

**The rail now reads in the order the person goes through it**: Set up your codebase, then Import
your work (optional), then Your direction. Before, Your direction was drawn above Import.

**Where the discovery canvas fits (point 2).** `design/ai-chat/onboarding--vibe-lockup.mock.html` is
not "A few questions". It is the canvas for a person who starts from an idea, reached from the
entrance's Start and from this bar's **Start from an idea instead**. Its new Panel 0 draws that path.
A person migrating code never reaches it.

**Yellow (point 3).** `--el-tint-yellow` with `--el-text-strong`, on small chips only; the tone stays
cool:

| element                             | before                              | now                                    | measured (WCAG)             |
| ----------------------------------- | ----------------------------------- | -------------------------------------- | --------------------------- |
| rail: Import's "optional" chip      | `--el-muted`, `--el-text-secondary` | `--el-tint-yellow`, `--el-text-strong` | 13.70:1 light, 10.14:1 dark |
| 1b: the "Open now" chip             | `--el-tint-lavender`                | `--el-tint-yellow`                     | 13.70:1 light, 10.14:1 dark |
| 6a: "Question 2 of about 5"         | (new)                               | `--el-tint-yellow`, `--el-text-strong` | 13.70:1 light, 10.14:1 dark |
| progress tracks (index, import, 6b) | `--el-tint-yellow` (Revision 5)     | kept                                   | —                           |

#### Slot → key (Revision 6, proposed — `messages/` is not edited here)

| slot                     | key                                    | English                                                                                                                                                                                       |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import body (inline)     | `onboardingMigrate.import.bodyInline`  | Already tracking work in Jira, Linear, GitHub, Plane or a CSV? Bring it in right here. You review a dry-run preview before anything is written. Skip this if you have no backlog to bring in. |
| 4f action                | `onboardingMigrate.import.continue`    | Continue                                                                                                                                                                                      |
| 6 eyebrow                | `onboardingMigrate.questions.eyebrow`  | Your direction                                                                                                                                                                                |
| 6 heading                | `onboardingMigrate.questions.heading`  | A few questions                                                                                                                                                                               |
| 6 body                   | `onboardingMigrate.questions.body`     | Motir has read your code. A few answers about where the project is going, and it drafts your first plan from both.                                                                            |
| 6a chip                  | `onboardingMigrate.questions.progress` | Question {n} of about {total}                                                                                                                                                                 |
| 6b title                 | `…questions.draftingTitle`             | Drafting your first plan                                                                                                                                                                      |
| 6b line                  | `…questions.draftingBody`              | From your code, your backlog and your answers. You can leave this page; Motir tells you when it is ready.                                                                                     |
| 6b line, code still read | `…questions.draftingWaits`             | Waiting for Motir to finish reading your code, then drafting starts by itself.                                                                                                                |
| 6c title                 | `…questions.readyTitle`                | Your first plan is ready                                                                                                                                                                      |
| 6c line                  | `…questions.readyBody`                 | {count, plural, one {# item is} other {# items are}} drafted for {project}. Nothing is final until you approve it.                                                                            |
| 6c action                | `…questions.readyCta`                  | Review your plan                                                                                                                                                                              |

The importer's steps, the composer placeholder and Send keep their existing `import.*` and
`onboarding.chat.*` keys. `onboardingMigrate.import.cta` (Open the importer) and `import.next`
(I've imported — continue) retire.

#### GIVES / TAKES (Revision 6)

- **GIVES MOTIR-8254** the inline importer: the importer's steps rendered inside the migrate wizard's
  Import step, Skip import in its Cancel slot, Continue on its finished state, and the vendor OAuth
  return to `/onboarding/migrate` (`lib/import/oauthReturn.ts` allows only `/onboarding/import` and
  `/settings/…` today, so the allow-list grows by one path). It also **GIVES** the "A few questions"
  step (6a–6d) inside the wizard, driven by the discovery turn API the canvas uses, with the hand-off
  to the plan review when the draft is ready, and Decision and Resume advancing in place. It
  **TAKES** the Open the importer link and the two hand-offs to `/onboarding/discovery`.
- **GIVES MOTIR-8255** nothing new to build: the discovery canvas keeps the idea path only, and its
  board gains a Panel 0 showing that door.
- **GIVES MOTIR-8256** the yellow chip pair (`--el-text-strong` on `--el-tint-yellow`) for its
  contrast run across every palette.
- **GIVES MOTIR-8257** a changed path: the migrate E2E no longer leaves the wizard for the importer
  or for discovery. **GIVES MOTIR-8258** the twelve keys above.

## Revision 7 (2026-10-13) — the connect step's pre-flight and every state it can return in (MOTIR-8469)

**Amends:** § _2026-10-12 — the vibe layout on the migrate wizard_ → **Revision 1** (§ _The four
states (Panels 2a–2d…)_, § _The detection mechanism_, § _Slot → key (Revision 1)_) and that
section's Panel 7 (the error alert, for the connect read only), as drawn in
[`onboarding-migrate--vibe-layout.mock.html`](./onboarding-migrate--vibe-layout.mock.html) Panels
2a–2d, 7 and 11. **Delta mock:**
[`onboarding-migrate--connect-states.mock.html`](./onboarding-migrate--connect-states.mock.html). Story
MOTIR-8241. Neither earlier mock is edited; where Revision 1 and this section disagree about the
connect step, this section wins.

**The card asked for three files: a re-exported `onboarding-migrate.png` and an edit of
`onboarding-migrate.mock.html`.** Both are replaced by this delta mock under
`docs/decisions/design-result.md` AMENDMENT 4 (`CLAUDE.md` § _Design assets_): a change to an
existing design is a new `<surface>--<change>.mock.html` holding only the changed panels, there is
no `.png` export any more, and an older mock is a record of its moment. The pack is therefore two
files — this section and the delta mock — and the folder's basenames are untouched.

**Design system — files read:** root `package.json` (`"@motir/design-system": "workspace:*"`),
`app/globals.css` (line 13 `@import '@motir/design-system/theme.css'`),
`packages/design-system/package.json` (**`0.14.0`**, exports `./mock`). **Verdict: ON MOTIR DESIGN —
branch (a).** The mock is built with `renderMock` from the package's real `Card`, `Button`,
`buttonVariants`, `Pill` and `Spinner`, axes `warm-editorial` · `motir` · `motir`, every frame a
`[data-appearance-scope]` carrying `data-theme`. The specimen-only `.style-vignette` rules
`theme.css` now carries are dropped from the inlined sheet (no mock carries them). Nothing is
proposed for the package; `EmptyState` is not used (the step's empty state is the pre-flight, which
is a list with an action, not an empty-state illustration).

**Shipped reality read this run:** `app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx`
(`ConnectPanel` l.720 — the `checking | waiting | missing | connected` union, `GIT_SETTINGS_HREF`,
the focus / visibility re-read, `CONNECT_POLL_MS`, `Continue` only in `connected`),
`components/onboarding/layout/WarmButton.tsx` (`WARM_CTA`), `lib/github/bannerStatus.ts`,
`components/settings/GitConnectBanner.tsx` +
`app/(authed)/settings/workspace/_components/gitSettingsPrimitives.tsx` (`SettingsBanner`'s tone
realisation), `app/api/github/setup/route.ts`, `lib/github/returnSurface.ts`, `lib/github/appLinks.ts`,
`app/(authed)/settings/organization/git/page.tsx` (l.218–224, the account list's `manageUrl`),
`messages/en.json` (`onboardingMigrate.connect.*`, `github.banner.*`), and MOTIR-8470's card.

### Build note — the folder, listed in full before drawing

```
design/onboarding-migrate/
  design-notes.md
  onboarding-migrate--vibe-layout.mock.html
  onboarding-migrate.mock.html
  onboarding-migrate.png
```

Files that draw a connect-step panel: **`onboarding-migrate.mock.html`** (MOTIR-930's Panel 1 —
the shipped-before-restyle connect, a record), **`onboarding-migrate.png`** (its export, a record),
and **`onboarding-migrate--vibe-layout.mock.html`** (Panels 2a–2d, 7 drawn over 2b, and 11 narrow).
Under AMENDMENT 4 none of them is amended in place; this delta mock is the amendment for all three.
The connect card's GitHub grant rows are composed from `design/github/` (7.7.1), which this
revision does not touch. No other file in the folder holds a connect panel.

### Which numbering governs — the panel index

The design of record numbers the connect step's panels **2a–2d** (Revision 1). The parent story's
"Panel 1" is MOTIR-930's original numbering (§ _Panel 1 — Connect repos_, above), which no current
board uses. **2a–2d governs.** The new panels continue it as **2e–2k**, so no existing id changes
meaning. The mock's first board section ("Index") is the surface table, one row per panel.

| card # | panel   | state                                   | vs. the record                                   | its one next action                                            |
| ------ | ------- | --------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| 1      | 2a      | Checking                                | amended (also covers the run still starting)     | none — resolves itself                                         |
| 2      | 2b      | Pre-flight (not connected — empty)      | **replaces** Revision 1's "Not connected yet"    | **Connect GitHub** (primary, warm)                             |
| 3      | 2e      | Starting                                | new                                              | none — the browser is leaving                                  |
| 4      | 2c      | Waiting for the round trip              | amended (reopens the install, not Settings)      | Open GitHub again (**secondary**)                              |
| 5      | 2d      | Connected                               | amended (provider mark, GitHub manage target)    | **Continue** (primary) · Manage repositories on GitHub (quiet) |
| 6      | 2f      | Already connected                       | new                                              | **Continue** (primary) · Add repositories on GitHub (quiet)    |
| 7      | 2g-i/ii | No repositories selected                | new (two variants: nothing chosen · none usable) | **Choose repositories on GitHub** (primary)                    |
| 8      | 2h      | Install cancelled                       | new                                              | **Connect GitHub** (primary) — the pre-flight's own control    |
| 9      | 2i      | Waiting for a GitHub organisation owner | new                                              | none · Open GitHub (secondary)                                 |
| 10     | 2j-1…4  | Something went wrong (the family)       | new                                              | **Connect GitHub** / **Try again** (primary)                   |
| 11     | 2k      | Could not check                         | new — supersedes Panel 7 for the connect read    | Check again (secondary)                                        |

Every panel is drawn in **light and dark** at 1280, as the work band only (rail + `StepHead` +
card + foot): the bar and the compact hero are unchanged and are not redrawn. **The access path** is
unchanged: the wizard's arrival on Connect, vibe-layout Panels 1a / 1b.

### The union — a total set, mapped onto the shipped one

The target union is the eleven values above and nothing else: `checking · preflight · starting ·
waiting · connected · alreadyConnected · noRepos(noneChosen | noneUsable) · cancelled ·
awaitingOwner · failed(outcome) · readFailed`. The shipped four map onto it as:

| shipped     | splits into                                       | why                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checking`  | `checking`                                        | unchanged name; it now also stands while the run is still being started (`runId === null`).                                                                                                                                                                                                                                                                                                  |
| `waiting`   | `waiting`, `starting`                             | `starting` is the few hundred ms between the press and the browser leaving, while the state is minted.                                                                                                                                                                                                                                                                                       |
| `missing`   | `preflight`, `noRepos`, `cancelled`, `readFailed` | `missing` is drawn today for **nothing installed** AND **installed with nothing usable** (`repos.length === 0` cannot tell them apart). Their next actions are opposite — install vs. change the selection of an existing installation — so one state cannot carry both. `cancelled` is `missing` after a send; `readFailed` is what a swallowed read silently showed as the previous state. |
| `connected` | `connected`, `alreadyConnected`                   | told apart by the client's sent-out flag: usable > 0 after a send is _connected_; usable > 0 on arrival is _already connected_ (no install is ever the primary there).                                                                                                                                                                                                                       |
| —           | `awaitingOwner`, `failed(outcome)`                | no shipped value: the round trip never lands on this step today (its origin is always `organizationGit`).                                                                                                                                                                                                                                                                                    |

### Tones — read from `lib/github/bannerStatus.ts` on 2026-10-13, not invented

The step renders a tone as a **`Pill` `severity`** of the same name (`success` → `--el-tint-mint`,
`info` → `--el-tint-sky`, `danger` → `--el-tint-rose`, each with `--el-text-strong`), carrying a
glyph and a label, above the status line — **never colour alone**: every state also has its own
glyph and its own title. States with no outcome draw no pill.

| outcome / state                                   | status read                       | tone (`GITHUB_BANNER_TONE`)                                                                                                        | panel |
| ------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- |
| install bound, repositories usable                | `installed`                       | **success**                                                                                                                        | 2d    |
| already connected on arrival                      | — (no round trip)                 | success — the same pair as 2d; nothing went wrong                                                                                  | 2f    |
| bound, nothing usable                             | — (a read, not a status)          | **info**, read from `select_repos` (the outcome that also asks the person to choose); deliberately NOT `repo_unavailable`'s danger | 2g    |
| owner approval requested                          | none yet (route says `installed`) | **info** — benign; MOTIR-8471 adds the status with this tone and lists it in `GITHUB_BENIGN_BANNER_STATUSES`                       | 2i    |
| link expired                                      | `install_expired`                 | **info** (benign)                                                                                                                  | 2j-1  |
| forbidden                                         | `install_forbidden`               | **danger**                                                                                                                         | 2j-2  |
| provider error                                    | `install_provider_error`          | **danger**                                                                                                                         | 2j-3  |
| tampered state · state for another user · generic | `install_error` (one status)      | **danger** — the route reports all three as one status, so one panel                                                               | 2j-4  |
| cancelled                                         | none (GitHub sends nothing)       | **none** — a glyph and a plain line; the OAuth grant's `denied` is danger on Settings and this step does not inherit it            | 2h    |
| could not check                                   | none (a read failure)             | **none** — benign: nothing the person did was lost                                                                                 | 2k    |

**Benign-never-danger holds:** an expired link, an owner-approval request and a cancelled install
are never drawn in the danger tint, and neither is "no repositories selected". **Not drawn, and
why:** `install_unbound` and `repos_updated` arrive with no state, so they can only return to the
default surface (Settings); `select_repos`, `repo_unavailable` and `installation_not_accessible`
come from the organisation branch, which only a state naming an `organizationId` reaches — the
already-installed-accounts story's flow, not this step's.

### The pre-flight (2b; repeated under 2h)

Three numbered rows in one `ol` (`aria-label` "What happens on GitHub"), each a 24 px numbered
circle (`border --el-border`, `--el-text-secondary` digit, `rounded-full`), a 16 px glyph, a
semibold title and a hint:

1. **Choose the account** (`Building2`) — your personal account, or a GitHub organisation you belong to.
2. **Choose the repositories** (`GitBranch`) — All repositories, or only the ones you select.
3. **Approve the access** (`Shield`) — followed by the **access rows: slots, not copy.**

**The access rows are bound to MOTIR-8470.** One row per permission the live Motir App requests,
in the order GitHub's install screen lists them; the **row count is whatever MOTIR-8470's comment
records** (the dated table in `docs/decisions/unlinked-pull-request-check.md` is not a source).
Grammar: `{what Motir can do} — {on what}`, one plain-language line per permission, the level
folded into the verb (reads / reads and changes). The mock draws three dashed slot rows
(`access row 1`, `2`, `…n`) and **quotes no permission string**. Each row: `rounded-(--radius-control)`,
`border border-dashed --el-border`, `px-(--spacing-control-x) py-1.5`, mono 12, `--el-text-secondary`,
a `Check` glyph. The build renders them solid (`--el-border-soft`, sans 14, `--el-text`) once the
copy exists; dashed is the mock's slot marker only.

A last line sets up state 9 before it happens: "Not an owner of the organisation? GitHub asks one of
its owners to approve instead, and this step waits for them."

### Per element — colour + shape role

| element                                                 | primitive                                       | colour role                                                               | shape / size                                                  |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| card                                                    | `Card` (`data-surface="card"`)                  | `--el-card`, `--el-border`                                                | `--radius-card`, `--spacing-card-padding`                     |
| tone chip                                               | `Pill severity={success\|info\|danger}`         | `--el-tint-mint` / `--el-tint-sky` / `--el-tint-rose`; `--el-text-strong` | `--radius-badge`, `--spacing-chip-x/y`; glyph 14 px           |
| status title                                            | —                                               | `--el-text`, semibold                                                     | 14 px                                                         |
| status hint · pre-flight hints                          | —                                               | `--el-text-secondary`                                                     | 14 px, `max-w-[60ch]`                                         |
| state glyph (neutral states)                            | lucide, aria-hidden                             | `--el-text-secondary`                                                     | 16 px                                                         |
| state glyph (success)                                   | `CheckCircle2`, aria-hidden                     | `--el-success`                                                            | 16 px                                                         |
| state glyph (danger)                                    | `TriangleAlert`, aria-hidden                    | `--el-danger-on-surface`                                                  | 16 px                                                         |
| spinner (2a, 2c, 2e)                                    | `Spinner sm`, aria-hidden wrapper               | `--el-highlight` (warm small mark, Revision 5)                            | `rounded-full`                                                |
| primary (Connect GitHub, Continue, Choose, Try again)   | `buttonVariants primary md` + `WARM_CTA`        | `--el-cta-warm` / `--el-cta-warm-text`                                    | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x`; `w-fit` |
| primary loading (2e)                                    | `Button loading`                                | same pair; `Spinner` inside; `aria-busy`, disabled                        | as above                                                      |
| secondary (Open GitHub again, Open GitHub, Check again) | `buttonVariants secondary md`                   | `--el-text` on transparent, `--el-button-border`                          | `--radius-btn`, `--height-btn-md`                             |
| quiet GitHub link (manage · add more)                   | `<a>`, underlined                               | `--el-text-secondary`; focus outline `--el-accent-on-surface`             | `--radius-control` focus box                                  |
| new-tab marker                                          | `ArrowUpRight` + sr-only "(opens in a new tab)" | inherits                                                                  | 16 px                                                         |
| repo row                                                | `li`                                            | `--el-border-soft`; owner `--el-text-secondary`, name `--el-text`         | `--radius-control`, `--spacing-control-x`, py-2.5, mono 13    |
| repo provider mark                                      | lucide `Github` + sr-only "GitHub"              | `--el-text-secondary`                                                     | 16 px                                                         |
| repo tick                                               | `Check`, aria-hidden                            | `--el-success`                                                            | 16 px                                                         |
| GitLab note                                             | —                                               | `--el-text-secondary`                                                     | 12 px                                                         |

Every status block is one `role="status"` region, so each change is announced politely; 2a keeps
`aria-busy`. No `--el-text-muted`, no `--el-text-faint`, no `--el-danger-text`, no raw colour.

### The GitHub-side controls name the surface they open — no URL is typed

| control                                                                                    | opens                                                                             | address, read from the code                                                                                                                               |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect GitHub · Try again · Open GitHub again · Open GitHub (2i)                          | GitHub's install screen for the Motir App                                         | `githubAppInstallUrl(state)` (`lib/github/appLinks.ts`) with the step's own signed state                                                                  |
| Manage repositories on GitHub · Add repositories on GitHub · Choose repositories on GitHub | the installation's settings page on GitHub (where the repository selection lives) | `githubInstallationManageUrl(installation)` — the builder Settings → Organisation → Git's account list uses for its own manage control (`page.tsx` l.224) |

In the mock each `href` is a fragment naming its builder (`#githubAppInstallUrl(state)`,
`#githubInstallationManageUrl(installation)`). The return to this step is MOTIR-8471's onboarding
surface **id**; no control assumes a path.

### Behaviour the board depicts (for MOTIR-8475)

1. **One primary or none, per panel.** 2b/2h: Connect GitHub is the only way out of the
   pre-flight. 2c and 2i have no primary (2i has nothing to press). 2k's retry is secondary.
2. **The exit is the shipped one, unchanged:** Continue (2d, 2f) calls the existing advance
   `connect → index`, which records the run's `connectedRepoRef`.
3. **Re-read on return stays** (Revision 1's focus / `visibilitychange` read and the ~5 s poll in
   2c); 2g re-reads on tab return only, because a selection change made on GitHub carries no state
   back (MOTIR-3755).
4. **Cancel is computed, not reported:** 2h = a read answering "not bound" after a send, compared
   with the read taken before it.
5. **2e opens the tab inside the click.** A popup blocker refuses a `window.open` after an `await`,
   so the state must already be minted (mint it when 2b renders and re-mint on focus if it is near
   its TTL), or the tab is opened blank in the click and navigated once the state arrives.

### Slot → key (Revision 7, proposed — `messages/` is not edited here)

All under `onboardingMigrate.connect.*` unless named.

| slot                                   | key                                                           | status                         | English                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a line                                | `checking`                                                    | unchanged                      | Checking for connected repositories…                                                                                                                                                                                         |
| 2b status line                         | `missingTitle`                                                | unchanged                      | No repositories connected yet                                                                                                                                                                                                |
| 2b intro                               | `preflightIntro`                                              | **NEW**                        | GitHub opens in a new tab and asks you three things. Then it sends you straight back to this step.                                                                                                                           |
| 2b list `aria-label`                   | `preflightLabel`                                              | **NEW**                        | What happens on GitHub                                                                                                                                                                                                       |
| 2b row 1 title · hint                  | `preflightAccount` · `preflightAccountHint`                   | **NEW**                        | Choose the account · Your personal account, or a GitHub organisation you belong to.                                                                                                                                          |
| 2b row 2 title · hint                  | `preflightRepos` · `preflightReposHint`                       | **NEW**                        | Choose the repositories · All repositories, or only the ones you select. You can change this later on GitHub.                                                                                                                |
| 2b row 3 title · hint                  | `preflightAccess` · `preflightAccessHint`                     | **NEW**                        | Approve the access · GitHub lists what the Motir app can read and change:                                                                                                                                                    |
| 2b access rows                         | `preflightAccessRows.<permission>`                            | **NEW (slots)**                | one key per permission MOTIR-8470 records — written by MOTIR-8473 from that comment, never from this asset                                                                                                                   |
| 2b access list `aria-label`            | `preflightAccessLabel`                                        | **NEW**                        | Access the Motir app asks for                                                                                                                                                                                                |
| 2b owner line                          | `preflightOwnerNote`                                          | **NEW**                        | Not an owner of the organisation? GitHub asks one of its owners to approve instead, and this step waits for them.                                                                                                            |
| 2b / 2h / 2j primary                   | `connectCta`                                                  | unchanged                      | Connect GitHub                                                                                                                                                                                                               |
| 2e loading label                       | `starting`                                                    | **NEW**                        | Opening GitHub…                                                                                                                                                                                                              |
| 2c title                               | `waitingTitle`                                                | unchanged                      | Waiting for GitHub                                                                                                                                                                                                           |
| 2c hint                                | `waitingHint`                                                 | **CHANGED**                    | Finish on GitHub in the other tab. It sends you back to this step, and this tab checks again when you return.                                                                                                                |
| 2c secondary                           | `reopenCta`                                                   | **CHANGED**                    | Open GitHub again                                                                                                                                                                                                            |
| 2d pill                                | `pillConnected`                                               | **NEW**                        | Connected                                                                                                                                                                                                                    |
| 2d line · hint · list label · Continue | `detected` · `detectedHint` · `listLabel` · `continue`        | unchanged                      | (as shipped)                                                                                                                                                                                                                 |
| 2d quiet link                          | `manage`                                                      | unchanged text, **new target** | Manage repositories on GitHub                                                                                                                                                                                                |
| repo provider sr-only                  | `providerGithub`                                              | **NEW**                        | GitHub                                                                                                                                                                                                                       |
| 2f pill · title · hint                 | `pillAlready` · `alreadyTitle` · `alreadyHint`                | **NEW**                        | Already connected · This organisation is already connected · Motir can already read these {count, plural, one {# repository} other {# repositories}}, so there is nothing to install. Continue, or add more on GitHub.       |
| 2f quiet link                          | `addMore`                                                     | **NEW**                        | Add repositories on GitHub                                                                                                                                                                                                   |
| 2g pill · title                        | `pillChooseRepos` · `noReposTitle`                            | **NEW**                        | Choose repositories · GitHub is connected, but no repositories are                                                                                                                                                           |
| 2g-i hint                              | `noReposNoneChosen`                                           | **NEW**                        | No repositories were chosen when the Motir app was installed. Choose at least one on GitHub, and this step picks it up when you come back.                                                                                   |
| 2g-ii hint                             | `noReposUnusable`                                             | **NEW**                        | The repositories you chose can't be connected to this organisation; they may already belong to another one. Choose others on GitHub, and this step picks them up when you come back.                                         |
| 2g primary                             | `chooseRepos`                                                 | **NEW**                        | Choose repositories on GitHub                                                                                                                                                                                                |
| 2h title · hint                        | `cancelledTitle` · `cancelledHint`                            | **NEW**                        | The install didn't finish · Nothing was connected and nothing is lost. Start again whenever you're ready.                                                                                                                    |
| 2i pill · title · hint                 | `pillOwner` · `ownerTitle` · `ownerHint`                      | **NEW**                        | Waiting on an owner · Waiting for a GitHub organisation owner · You asked an owner of the GitHub organisation to approve the Motir app. Onboarding picks it up as soon as they do, so you can leave this page and come back. |
| 2i secondary                           | `ownerOpen`                                                   | **NEW**                        | Open GitHub                                                                                                                                                                                                                  |
| 2j pills                               | `pillExpired` · `pillNotConnected`                            | **NEW**                        | Link expired · Not connected                                                                                                                                                                                                 |
| 2j-1 title · hint                      | `outcome.install_expired.title` · `.hint`                     | **NEW**                        | The GitHub link expired while you were there · Nothing is broken. Start again from this step.                                                                                                                                |
| 2j-2 title · hint                      | `outcome.install_forbidden.title` · `.hint`                   | **NEW**                        | This install was started from a workspace you're not in · Nothing was connected. Start again from this step, signed in as yourself.                                                                                          |
| 2j-3 title · hint · primary            | `outcome.install_provider_error.title` · `.hint` · `tryAgain` | **NEW**                        | Motir couldn't reach GitHub to finish connecting · Nothing on GitHub was undone. Try again in a moment. · Try again                                                                                                          |
| 2j-4 title · hint                      | `outcome.install_error.title` · `.hint`                       | **NEW**                        | Connecting GitHub didn't finish · Motir couldn't confirm this install came from this step, so nothing was connected. Start again from here.                                                                                  |
| 2k title · hint · secondary            | `readFailedTitle` · `readFailedHint` · `recheck`              | **NEW**                        | Motir couldn't check the connection just now · Nothing you did on GitHub is lost. This step checks again when you come back to the tab, or now. · Check again                                                                |
| sr-only after each new-tab control     | `newTab`                                                      | unchanged                      | (opens in a new tab)                                                                                                                                                                                                         |
| GitLab note                            | `gitlabNote`                                                  | unchanged                      | GitLab connect is coming soon.                                                                                                                                                                                               |
| —                                      | `missingHint`                                                 | **DELETE**                     | (replaced by `preflightIntro`)                                                                                                                                                                                               |
| **settings banner** (not drawn)        | `github.banner.install_requested`                             | **NEW (slot only)**            | the owner-approval words on Settings → Organisation → Git; MOTIR-8473 writes them, MOTIR-8471 emits the status                                                                                                               |

**Locale set:** every **NEW** and **CHANGED** row above, plus the banner slot, needs a `zh`
twin (MOTIR-8474) and the nine other app languages (MOTIR-8479). Unchanged and DELETE rows need
nothing new. Repository names (`acme/web`, `acme/api`, `acme/infra`) and counts are fixtures.

### AA — the measured pairs (motir palette, resolved from `theme.css` + `globals.css` with `tests/theme/paletteCascade.ts`, WCAG 2.x)

| ink → ground                                              | light   | dark    | needs |
| --------------------------------------------------------- | ------- | ------- | ----- |
| `--el-text` → `--el-card`                                 | 17.63:1 | 16.75:1 | 4.5   |
| `--el-text-secondary` → `--el-card` / `--el-page-bg`      | 6.75:1  | 8.64:1  | 4.5   |
| `--el-text-secondary` → `--el-surface` (rail current row) | 5.91:1  | 7.81:1  | 4.5   |
| `--el-text-strong` → `--el-tint-mint` (success pill)      | 12.90:1 | 11.08:1 | 4.5   |
| `--el-text-strong` → `--el-tint-sky` (info pill)          | 12.66:1 | 11.14:1 | 4.5   |
| `--el-text-strong` → `--el-tint-rose` (danger pill)       | 12.35:1 | 11.30:1 | 4.5   |
| `--el-text-strong` → `--el-tint-yellow` (rail chip)       | 13.70:1 | 10.14:1 | 4.5   |
| `--el-cta-warm-text` → `--el-cta-warm` (primary)          | 4.65:1  | 5.89:1  | 4.5   |
| `--el-success` → `--el-card` (glyph, tick)                | 4.97:1  | 7.62:1  | 3     |
| `--el-danger-on-surface` → `--el-card` (glyph)            | 8.29:1  | 6.17:1  | 3     |
| `--el-highlight` → `--el-card` (spinner, dot)             | 3.80:1  | 5.89:1  | 3     |
| `--el-accent-on-surface` → `--el-card` (focus outline)    | 6.31:1  | 10.00:1 | 3     |

Dark parity: every panel is drawn twice, the second frame carrying `data-theme="dark"` on its own
`[data-appearance-scope]`; `tests/design-dark-parity.test.ts` computes the nested dark scope and is
green on this mock, as are both ink arms (`design-ink-contrast`, `design-state-ink-contrast`).
**Narrow (390)** is not redrawn: the step follows Panel 11's rule (rail above, one column); the
pre-flight rows stack and the slot rows wrap.

### Findings

- **F1 — the shipped "Manage repositories on GitHub" link opens Motir's own Settings page**
  (`GIT_SETTINGS_HREF`, `MigrateWizard.tsx` l.901), not GitHub. 2d points it at the installation's
  page on GitHub, which needs the installation reference from MOTIR-8472.
- **F2 — `setup_action=request` is reported as `installed`** (`app/api/github/setup/route.ts`
  l.76–78), a success tone for an install that has not happened. 2i forbids it on this step and on
  the Settings banner alike.
- **F3 — nothing binds an owner-approved install to this organisation today.** The owner finishes
  on GitHub in their own browser, without the member's signed state, so the setup URL sees an
  install with no state (`install_unbound`). "Onboarding picks it up when they do" needs a producer
  (MOTIR-8471 / MOTIR-8472); 2i draws the promise and names the gap.
- **F4 — the read swallows its failures** (`catch {}` in `ConnectPanel.read`), so 2k has no
  producer until MOTIR-8472 makes the failure reportable.
- **F5 — the repo rows' `GitBranch` glyph becomes the provider mark** (`Github`, sr-only "GitHub"),
  as the card asks; GitLab rows will take theirs when MOTIR-1470 lands.

### GIVES / TAKES

- **MOTIR-8475 (the connect step)** — **GIVES** panels 2a–2k, the eleven-value union above, each
  state's one action, the tone-as-`Pill` rule and behaviour 1–5. **TAKES** the link to
  `/settings/organization/git` from every connect state (both the primary and the manage link) and
  `missingHint`. Bigger than sized: seven new panels, of which the pre-flight and the
  failure family are the bulk — **re-estimate it** (not done here; see the run report).
- **MOTIR-8473 (copy)** — **GIVES** the slot → key table above, the pre-flight's three lines, and
  the `github.banner.install_requested` slot. **TAKES** `missingHint`.
- **MOTIR-8474 (Chinese)** and **MOTIR-8479 (nine languages)** — **GIVE** the locale set: the NEW and
  CHANGED rows plus the banner slot. Nothing taken.
- **MOTIR-8472 (the connect step's read)** — **GIVES** the reads each state needs: installation
  bound (y/n); usable-repository count; selected-repository count (2g-i vs 2g-ii); the installation
  reference behind the manage / choose controls (account login, account type, installation id —
  what `githubInstallationManageUrl` takes); and a **reportable read failure** (2k). States 6, 7
  and 8 must be distinguishable from it; `repos.length > 0` alone is not enough. Nothing taken.
- **MOTIR-8471 (the App-install round trip)** — **GIVES** the outcomes that must land on this step
  (2i, 2j-1…4), the onboarding return-surface id, the rule that a `request` is never `installed`
  (here and on Settings), the new status with the `info` tone (F2), and F3. Nothing taken.
- **MOTIR-8470 (permissions verification)** — **TAKES** nothing and is given nothing to build; it
  **supplies** the access rows' content and count. This asset quotes none.
- **MOTIR-8476 (integration)** — **GIVES** the outcome list it exercises: `installed` → 2d,
  `request` → 2i, `install_expired`, `install_forbidden`, `install_provider_error`, `install_error`
  → 2j, each against the onboarding surface as well as Settings. Nothing taken.
- **MOTIR-8477 (E2E)** — **GIVES** the acceptance walk: all eleven panels in English and Chinese,
  including 2f, 2g, 2h, 2i, 2j and 2k, not the happy path alone. Nothing taken.
- **MOTIR-8480 (exit gate)** and **MOTIR-8481 (substrate)** — 2f is the state their organisation-tier
  gate makes reachable ("whichever of its workspaces connected them"); nothing given or taken.

## Revision 8 (2026-10-16) — the connect step's already-installed accounts: account list, GitHub sign-in prompt, repository picker and every link outcome (MOTIR-8758)

**Amends:** § _Revision 7_ (the connect step's eleven states, panels 2a–2k, as drawn in
[`onboarding-migrate--connect-states.mock.html`](./onboarding-migrate--connect-states.mock.html)) by
ADDING states to the step's card body. It reuses, unchanged, the Settings picker's row kinds from
`design/github/` § _MOTIR-8217_ ([`github--multi-org-account.mock.html`](../github/github--multi-org-account.mock.html)
panels A2a–A5, built by MOTIR-8223). **Delta mock:**
[`onboarding-migrate--installed-accounts.mock.html`](./onboarding-migrate--installed-accounts.mock.html).
Story MOTIR-8245. No earlier mock is edited and no earlier Revision is rewritten; where Revision 7
and this section disagree about the connect step's card body, this section wins.

**The card asked for three files: an edit of `onboarding-migrate.mock.html` and a re-exported
`onboarding-migrate.png`.** Both are replaced by this delta mock under
`docs/decisions/design-result.md` AMENDMENT 4 (`CLAUDE.md` § _Design assets_), exactly as Revision 7
recorded for its own card: a change is a new `<surface>--<change>.mock.html` holding only the changed
panels, and there is no `.png` export any more. The pack is two files — this section and the delta
mock. (Recorded as a build-through discrepancy on MOTIR-8758.)

**Read before drawing:** `origin/main` at **`b6fc3af5d`** (2026-10-15). The folder's last section was
Revision 7, so this is **Revision 8**. Both published predecessor results were fetched with
`get_design` — MOTIR-8469 (`connect-states.mock.html` + this notes file, byte-identical to the
committed mirror) and MOTIR-8217 (`github--multi-org-account.mock.html`).

**The words are MOTIR-8759's.** The sibling copy card already fixes the English and Chinese for this
surface under `onboardingMigrate.connect.existing.*` and says the design "draws where the strings
sit, and does not gate their words". This board therefore draws MOTIR-8759's English verbatim, reuses
shipped keys where that card has none (the Settings picker's search, select-all, picker error and
nothing-left count labels; the predecessor's status lines), and adds **one** key that card does not
have (`existing.identity.declinedHint`, below).

**Design system — files read:** root `package.json` (`"@motir/design-system": "workspace:*"`),
`app/globals.css` (line 13 `@import '@motir/design-system/theme.css'`),
`packages/design-system/package.json` (**`0.14.0`**, exports `./mock`). **Verdict: ON MOTIR DESIGN —
branch (a).** The mock is built with `renderMock` from the package's real `Card`, `Button`, `Pill`,
`Spinner`, `Checkbox`, `Input` and `ErrorState`, axes `warm-editorial` · `motir` · `motir`, every
frame a `[data-appearance-scope]` carrying `data-theme`. Nothing is proposed for the package.
`EmptyState` is deliberately not used: "no accounts" is the pre-flight (2n) and "nothing left" is an
explicit reasoned panel (2q), neither an illustration.

**Shipped reality read this run:** `app/(onboarding)/onboarding/migrate/_components/ConnectPanel.tsx`
(MOTIR-8475 — the eleven-value `ConnectStepState`, `StatusBlock`, `Preflight`, `RepoList`, the foot row
with the quiet manage link and Continue, `REPORT_OF_STATUS` with `select_repos → read`),
`components/onboarding/layout/WarmButton.tsx` (`WARM_CTA`), `lib/github/bannerStatus.ts`
(`GITHUB_BANNER_TONE`), `app/(authed)/settings/organization/git/_components/` (`ConnectGithubFlow.tsx`,
`RepoPickerRow.tsx`, `NoReposLeftPanel.tsx`, `githubAccounts.ts`), `lib/dto/github.ts`
(`GithubAccountsForOrganizationDTO`, `GithubAccountRepositoriesDTO`),
`app/api/organizations/[orgId]/github/{accounts,installations}/route.ts` (their status lists),
`messages/en.json` (`github.picker.*`, `onboardingMigrate.connect.*`) and MOTIR-8759's `## Strings`.

### Build note — the folder, listed in full before drawing

```
design/onboarding-migrate/
  design-notes.md
  onboarding-migrate--connect-states.mock.html
  onboarding-migrate--vibe-layout.mock.html
  onboarding-migrate.mock.html
  onboarding-migrate.png
```

The connect step's current design of record is `onboarding-migrate--connect-states.mock.html`
(Revision 7, 2a–2k). The other three files are records of earlier moments. This delta amends the
first and touches none of them.

### Which numbering governs — the panel index

**2a–2k (Revision 7) governs** and keeps its meaning. The new panels continue it as **2l–2t**, one
letter per numbered state on MOTIR-8758, with roman sub-panels for that state's variants. The board's
first section is this index.

| card state | panels       | state                                                                                                                                                                              | its next action                                                         |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1          | 2l.i · 2l.ii | Account list, populated — one account; three, linked and not linked mixed                                                                                                          | Choose repositories (per row) · Install on another account (row)        |
| 2          | 2m.i · 2m.ii | Account list loading (skeleton under the checking spinner) · could not read                                                                                                        | none · Try again (secondary)                                            |
| 3          | 2n           | No accounts → the pre-flight **as shipped**, unchanged                                                                                                                             | Connect GitHub (primary)                                                |
| 4          | 2o.i–iv      | Identity prompt: default · in flight · back from the round trip (list, no prompt) · declined or not finished                                                                       | Sign in with GitHub (primary) · Skip and install instead (quiet)        |
| 5          | 2p.i–iv      | Picker: the three row kinds · loading · error with retry · 54 rows, scrolling, sticky footer                                                                                       | Connect N (primary, disabled at 0) · Back to accounts                   |
| 6          | 2q           | Nothing left to offer                                                                                                                                                              | Choose another account (secondary) · Add repositories on GitHub (quiet) |
| 7          | 2r.i · 2r.ii | `select_repos` arrival opens the picker for that installation · unreachable installation                                                                                           | Connect N · Choose repositories on another account                      |
| 8          | 2s.i–vii     | Linked · taken meanwhile (409) · empty selection (422 guard) · no longer in the installation (422) · no longer accessible with / without other accounts (403) · not an admin (403) | Continue · Connect N (×3) · Install on another account (×3)             |
| 9          | 2t.i–iii     | With Already connected (list below) · Waiting for an owner (list above, line below) · Install cancelled (list above, line below)                                                   | Continue · Choose repositories                                          |

Every panel is drawn in light and dark (two `[data-appearance-scope]` frames). Only the card body
changes; the rail and StepHead are the shipped ones.

### The access path

connect step → **account list** (2l) — or the **identity prompt** (2o) when Motir has no GitHub
sign-in for the person, or the **pre-flight** (2n) when there is no account → Choose repositories on
an account → **picker** (2p; or **nothing left**, 2q) → Connect N → **linked** (2s.i) → Continue →
Index. The install round trip re-enters at the picker: GitHub returns `select_repos` with an
`installation_id`, and the step opens the picker for that installation (2r.i). The install row is
present wherever the person can still install, and the identity prompt can always be skipped to the
pre-flight — **no state depends on signing in with GitHub to install**.

### Layout, element by element (colour role · shape token)

| element                        | part                                                                                                                                    | colour                                                                                                                                             | shape                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| account-list head              | glyph `Building2` + `existing.title` + `existing.hint`                                                                                  | `--el-text-secondary` glyph · `--el-text` title · `--el-text-secondary` hint                                                                       | —                                                                               |
| account row                    | `<button>` named _Choose repositories from {login}_: avatar disc · login · type pill · link pill · _Choose repositories_ + chevron      | login `--el-text`; disc `--el-avatar-fallback` / `--el-text-inverted`; action `--el-link`; hover `--el-option-active-bg`                           | `--radius-control`, `--spacing-control-x/y`, `--height-control` (Settings' row) |
| type pill                      | `Pill tone="neutral"` + `Building2` / `UserRound` + _GitHub organisation_ / _Personal account_                                          | `--el-chip-bg` / `--el-text-secondary`                                                                                                             | `--radius-badge`, `--spacing-chip-x`                                            |
| link pill                      | `Pill severity="success"` + `Check` + _Already linked to this organisation_ · or `Pill tone="neutral"` _Not linked_                     | `--el-tint-mint` / `--el-text-strong` · `--el-chip-bg` / `--el-text-secondary`                                                                     | `--radius-badge`                                                                |
| install row                    | Settings' dashed row: `Plus` disc, _Install on another account_ + hint, `ExternalLink`                                                  | border `--el-button-border`; disc `--el-card-icon-bg` / `--el-card-icon-fg`; hint `--el-text-secondary`                                            | `--radius-control`, `--spacing-control-x/y`                                     |
| identity prompt                | inset panel: `UserRound` + title + hint, then primary + skip                                                                            | panel `--el-surface-soft`, border `--el-border`; title `--el-text`; hint and skip `--el-text-secondary` (6.40 / 8.12 — never muted on this ground) | `--radius-card`, `--spacing-card-padding`                                       |
| one-line notice (2o.iv, 2r.i)  | `Info` + one sentence                                                                                                                   | `--el-tint-sky` / `--el-text-strong`                                                                                                               | `--radius-control`, `--spacing-control-x/y`                                     |
| outcome notice (2s.ii, iv–vii) | `Info` + title (semibold) + hint                                                                                                        | `--el-tint-sky` / `--el-text-strong`                                                                                                               | `--radius-control`, `--spacing-control-x/y`                                     |
| picker back                    | `ArrowLeft` + _Back to accounts_                                                                                                        | `--el-link`                                                                                                                                        | —                                                                               |
| picker head                    | initial disc + _Repositories in {login}_ + `picker.hint`                                                                                | as account row; hint `--el-text-secondary`                                                                                                         | —                                                                               |
| search                         | `Input` with `Search` addon                                                                                                             | the part's own                                                                                                                                     | `--radius-input`, `--height-input`                                              |
| select-all + counter           | `Checkbox labelVisible` · `picker.selectedCount` (`aria-live`)                                                                          | `--el-text` · `--el-text-secondary`                                                                                                                | —                                                                               |
| repository row                 | `RepoPickerRow`'s markup: `Checkbox`, owner/ + name, availability mark; `sr-only` _Available_ / _This repository can't be chosen here._ | owner `--el-text-secondary`, name `--el-text` (locked rows `--el-text-secondary`); `Lock` / `Check` `--el-icon-muted`                              | `--radius-control`, `--height-control`                                          |
| just-taken row (2s.ii)         | the same row, locked, with `Info` beside _Connected to another organisation_                                                            | row ground `--el-tint-sky`; all its text `--el-text-strong`                                                                                        | `--radius-control`                                                              |
| picker footer                  | top rule, guard text left, primary right; **sticky** in 2p.iv                                                                           | rule `--el-border-soft`; sticky ground `--el-card`                                                                                                 | —                                                                               |
| nothing left                   | `CircleSlash` + title, two count tiles, hint, two actions                                                                               | tiles border `--el-border-soft`, label `--el-text-secondary`, glyph `--el-icon-muted`, number `--el-text`                                          | tiles `--radius-card`, `--spacing-control-x/y`                                  |
| primaries                      | Sign in with GitHub · Connect N · Connect GitHub · Continue                                                                             | `--el-cta-warm` / `--el-cta-warm-text` (`WARM_CTA`)                                                                                                | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x`                            |

**Never colour alone:** each type pill carries a building or person glyph; the linked pill a check;
each locked repository a lock or a check beside its words; the just-taken row an `Info` glyph and its
words; every notice an `Info` glyph.

### Behaviour the board depicts

1. **One primary per panel, at most.** The account list has none: each row's _Choose repositories_
   is the choice, the install row is secondary. The identity prompt's sign-in is its one primary; the
   picker's is Connect N; linked and already-connected keep Continue.
2. **The account list sits ABOVE the install control and replaces the pre-flight's lone Connect
   GitHub** whenever the accounts read answers at least one account. With none (2n), the step is the
   shipped pre-flight unchanged.
3. **The identity prompt is skippable.** Skip removes the prompt for this visit and shows the
   pre-flight (2b as shipped). Sign-in leaves in the same tab and returns to this step, which reads
   the accounts again and shows the list with no stale prompt (2o.iii).
4. **A linked-here account stays pickable** (2l.ii): its picker shows its connected repositories
   checked and locked (_Connected here_), so the person can add more.
5. **`connected_elsewhere` names nobody** — the row says _Connected to another organisation_ and
   nothing else, in the picker, the nothing-left counts and every outcome.
6. **Taken meanwhile (409)** re-reads the repositories: the outcome sits on top of the picker, the
   named row is marked in place (tinted, locked, `Info`), every other choice is kept and Connect N
   stays enabled; nothing was written.
7. **422** has two faces: zero selected is prevented (Connect disabled, `outcome.selectionRequiredTitle`
   in the footer as secondary text — not an alert; should the 422 come back anyway the full outcome
   shows on top), and a repository no longer in the installation re-reads the list in place with the
   outcome on top and the remaining selection kept.
8. **403 is two different outcomes.** `installation_not_accessible` removes that account from the
   list and says why (2s.v; when it was the last, 2s.vi leaves the install row). A member's refusal
   (not an organisation admin) replaces the account list and the identity prompt with its outcome
   and keeps the install row (2s.vii). The step tells the two apart by the response body code, never
   by the status (MOTIR-8765 asserts they differ).
9. **`select_repos`** opens the picker directly, under `picker.fromInstallHint` (2r.i); an
   installation the person cannot reach shows the shipped `installation_not_accessible` line above
   whatever the accounts read gives (2r.ii).
10. **Combinations** (card #9): Already connected keeps its block and Continue on top, with the list
    below as the secondary way to add more (2t.i); Waiting for an owner and Install cancelled keep
    the list above and their shipped status line below, with no second install button — the install
    row in the list is the retry (2t.ii, 2t.iii).

### The data each state needs

- **Account** (list rows): login · type (GitHub organisation / personal account) · avatar (or the
  initial) · link state (already linked here / not linked).
- **The accounts read's three answers:** accounts (0..n) · identity required · a failure (2m.ii).
  Plus whether the person may link at all (organisation admin), which decides 2s.vii.
- **Repository** (picker rows): full name · availability (available / connected here / connected
  elsewhere). **Counts** for nothing-left: connected here · connected elsewhere.
- **Link outcome:** success with the connected repositories; or a refusal by kind — taken meanwhile
  naming the repository or repositories; selection empty; repository no longer visible;
  installation not accessible; not an admin.
- **Arrival:** the `select_repos` return and its installation reference.

### Slot → key (Revision 8)

MOTIR-8759 owns the words; this table says where each one sits. **8759** rows are that card's keys
under `onboardingMigrate.connect.existing.*`, English verbatim from its `## Strings`. **Reused**
rows already ship in all eleven languages. **GIVES** is the one key this board needs that MOTIR-8759
does not list.

| slot                             | key                                                                                                                    | status           | English                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account-list title · hint        | `existing.title` · `existing.hint`                                                                                     | 8759             | Your GitHub accounts with the Motir App · The Motir App is already installed on these accounts. Pick one to connect its repositories here. You do not need to install again. |
| 2m.i loading line                | `existing.loading`                                                                                                     | 8759             | Looking for your GitHub accounts…                                                                                                                                            |
| type pill                        | `existing.typeOrg` · `existing.typeUser`                                                                               | 8759             | GitHub organisation · Personal account                                                                                                                                       |
| linked pill                      | `existing.linkedHere`                                                                                                  | 8759             | Already linked to this organisation                                                                                                                                          |
| not-linked pill                  | `github.picker.notLinked`                                                                                              | reused           | Not linked                                                                                                                                                                   |
| row action · its accessible name | `existing.pickCta` · `existing.pickAria`                                                                               | 8759             | Choose repositories · Choose repositories from {login}                                                                                                                       |
| account-list `aria-label`        | `github.picker.accountsLabel`                                                                                          | reused           | Accounts                                                                                                                                                                     |
| install row · hint               | `existing.installAnotherCta` · `existing.installAnotherHint`                                                           | 8759             | Install on another account · Use this if the account you want is not listed.                                                                                                 |
| 2m.ii title · hint · retry       | `existing.loadErrorTitle` · `existing.loadErrorHint` · `existing.retryCta`                                             | 8759             | We could not read your GitHub accounts · Nothing was changed. Try again, or install on another account. · Try again                                                          |
| 2o title · hint · primary · skip | `existing.identity.title` · `.hint` · `.cta` · `.skipCta`                                                              | 8759             | (as in 8759)                                                                                                                                                                 |
| 2o.ii loading label              | `starting`                                                                                                             | reused           | Opening GitHub…                                                                                                                                                              |
| 2o.iv line                       | `existing.identity.declinedHint`                                                                                       | **GIVES → 8759** | GitHub did not sign you in, so nothing was changed. Try again, or skip and install instead.                                                                                  |
| picker head · hint · back        | `existing.picker.heading` · `.hint` · `.backCta`                                                                       | 8759             | Repositories in {login} · Choose the repositories this organisation connects. Nothing is connected until you confirm. · Back to accounts                                     |
| 2r.i line                        | `existing.picker.fromInstallHint`                                                                                      | 8759             | You chose an account the Motir App is already installed on. Choose which of its repositories this organisation connects.                                                     |
| 2p.ii line                       | `existing.picker.loading`                                                                                              | 8759             | Loading repositories…                                                                                                                                                        |
| search · select-all              | `github.picker.search` · `github.picker.selectAll`                                                                     | reused           | Search repositories · Select all available ({count})                                                                                                                         |
| counter · Connect N              | `existing.picker.selectedCount` · `existing.picker.confirmCta`                                                         | 8759             | {count} repositories selected · Connect {count} repositories (disabled at 0)                                                                                                 |
| row marks                        | `existing.picker.available` (sr-only) · `.connectedHere` · `.connectedElsewhere` · `.connectedElsewhereHint` (sr-only) | 8759             | Available · Connected here · Connected to another organisation · This repository can't be chosen here.                                                                       |
| 2p.iii                           | `github.picker.reposError.title` · `.body` · `github.picker.retry`                                                     | reused           | Couldn't load repositories · (as shipped) · Try again                                                                                                                        |
| 2q title · hint · link           | `existing.picker.nothingLeftTitle` · `.nothingLeftHint` · `.nothingLeftCta`                                            | 8759             | Nothing left to connect from this account · (as in 8759) · Add repositories on GitHub                                                                                        |
| 2q count labels · button         | `github.picker.noneLeft.connectedHere` · `.connectedElsewhere` · `.chooseAnother`                                      | reused           | Connected to this organisation · Connected to other organisations · Choose another account                                                                                   |
| 2s.i                             | `existing.outcome.linkedTitle` · `.linkedHint` + `pill.connected` · `detected` · `continue`                            | 8759 + reused    | Repositories connected · (as in 8759)                                                                                                                                        |
| 2s.ii                            | `existing.outcome.takenTitle` · `.takenHint`                                                                           | 8759             | A repository was taken while you were choosing · Another organisation connected {repos}. …                                                                                   |
| 2s.iii guard                     | `existing.outcome.selectionRequiredTitle` (· `.selectionRequiredHint` if a 422 returns)                                | 8759             | Choose at least one repository                                                                                                                                               |
| 2s.iv                            | `existing.outcome.notVisibleTitle` · `.notVisibleHint`                                                                 | 8759             | A repository is no longer in this installation · Nothing was connected. The list is updated, so choose again.                                                                |
| 2s.v · 2s.vi                     | `existing.outcome.notAccessibleTitle` · `.notAccessibleHint`                                                           | 8759             | You can no longer reach that account · (as in 8759)                                                                                                                          |
| 2s.vii                           | `existing.outcome.notAdminTitle` · `.notAdminHint`                                                                     | 8759             | Only an organisation admin can link an existing installation · (as in 8759)                                                                                                  |
| 2r.ii line                       | `pill.notConnected` · `outcome.installation_not_accessibleTitle` · `…Hint`                                             | reused           | (as shipped)                                                                                                                                                                 |
| 2t.\* status lines               | `pill.*`, `alreadyConnected*`, `ownerPending*`, `cancelled*`, `continue`, `manage`                                     | reused           | (as shipped)                                                                                                                                                                 |

**Locale set:** MOTIR-8759's keys plus `existing.identity.declinedHint` need `zh` (MOTIR-8759) and
the nine other app languages (MOTIR-8761). Reused keys already exist in all eleven. Account logins
(`acme-labs`, `acme-mobile`, `dana-okafor`), repository names and counts are fixtures.

### AA — the measured pairs (motir palette, computed in the rendered mock's own light and dark scopes, WCAG 2.x)

| ink → ground                                                                        | light   | dark    | needs |
| ----------------------------------------------------------------------------------- | ------- | ------- | ----- |
| `--el-text` → `--el-card`                                                           | 17.63:1 | 16.75:1 | 4.5   |
| `--el-text-secondary` → `--el-card`                                                 | 6.75:1  | 8.64:1  | 4.5   |
| `--el-text` → `--el-surface-soft` (identity prompt title)                           | 16.73:1 | 15.74:1 | 4.5   |
| `--el-text-secondary` → `--el-surface-soft` (identity prompt hint, skip)            | 6.40:1  | 8.12:1  | 4.5   |
| `--el-text-strong` → `--el-tint-sky` (notices, outcomes, just-taken row, info pill) | 12.66:1 | 11.14:1 | 4.5   |
| `--el-text-strong` → `--el-tint-mint` (linked pill, success pill)                   | 12.90:1 | 11.08:1 | 4.5   |
| `--el-text-secondary` → `--el-chip-bg` (type pill, not-linked pill)                 | 5.91:1  | 7.81:1  | 4.5   |
| `--el-link` → `--el-card` (Choose repositories, Back to accounts)                   | 6.31:1  | 8.89:1  | 4.5   |
| `--el-text-inverted` → `--el-avatar-fallback` (initial disc)                        | 6.31:1  | 8.89:1  | 4.5   |
| `--el-cta-warm-text` → `--el-cta-warm` (primaries)                                  | 4.65:1  | 5.89:1  | 4.5   |
| `--el-icon-muted` → `--el-card` (lock, check, external glyphs)                      | 6.07:1  | 7.78:1  | 3     |

The overlapping pairs reproduce Revision 7's numbers exactly. No text in the asset is painted with
`--el-text-muted` or `--el-text-faint`, and no danger ink is used anywhere on the board.

### Findings

- **F1 — the onboarding identity prompt is not Settings' identity panel.** Settings' `identity`
  copy sends the person to _Settings → Account → Git accounts_; on onboarding that would leave the
  wizard. This step signs in in place and returns (2o), with MOTIR-8759's own `existing.identity.*`
  words. The sign-in that returns to the onboarding surface is MOTIR-8762's.
- **F2 — `installation_not_accessible` is `danger` in `GITHUB_BANNER_TONE`**, but on this step the
  person did nothing wrong, and the card asks for a benign tone for every non-success state. 2r.ii
  draws it **info** on the connect step only; Settings' banner tone is not changed here.
- **F3 — taken meanwhile is an outcome, not a row error.** Settings marks the named row with a
  `--el-danger-on-surface` sentence (`RepoPickerRow`'s `error`). MOTIR-8759 words it as an outcome
  with a title and a hint, so 2s.ii puts the outcome on top and marks the named row in place with a
  benign tint. The picker row's markup is otherwise `RepoPickerRow`'s; the onboarding picker does not
  pass its `error`.
- **F4 — the two 403s are only distinguishable by body code** (behaviour 8).
- **F5 — `confirmCta` has no zero form.** At zero selected the disabled primary reads _Connect 0
  repositories_; the footer's guard line carries the meaning. A `=0` arm is the copy card's call, not
  this board's.

### GIVES / TAKES

- **MOTIR-8759 (copy, EN + ZH)** — **GIVES** where each of its keys sits (the slot table) and ONE key
  it does not list: `existing.identity.declinedHint` (2o.iv). **TAKES** nothing.
- **MOTIR-8761 (nine languages)** — **GIVES** the same added key beside MOTIR-8759's set. Nothing taken.
- **MOTIR-8762 (account list, sign-in, admin gate)** — **GIVES** 2l, 2m, 2n, 2o, 2s.v–vii, 2t and
  behaviour 1–4, 8, 10. **TAKES** the pre-flight's place as the step's FIRST body whenever at least
  one account is listed (the pre-flight's lone Connect GitHub becomes the install row there).
- **MOTIR-8763 (picker, nothing left, `select_repos`)** — **GIVES** 2p, 2q, 2r and behaviour 5, 9.
  **TAKES** the `select_repos` read's mapping to a status line with a link to GitHub: arrival now
  opens the picker for that installation.
- **MOTIR-8764 (confirm and outcomes)** — **GIVES** 2s.i–iv and behaviour 6–8. Nothing taken.
- **MOTIR-8760 (setup-route pin)** — **GIVES** the arrival 2r.i depends on (`select_repos` +
  `installation_id` back to this step). Nothing taken.
- **MOTIR-8765 (integration)** — **GIVES** the outcomes it must keep distinguishable: taken
  meanwhile, nothing left (both counts), no longer accessible vs not an admin. Nothing taken.
- **MOTIR-8766 (E2E)** — **GIVES** the walk: list → Choose repositories → picker → Connect N →
  linked → Continue, in English and Chinese, plus the identity prompt. Nothing taken.

### Sweep

- **Keys:** every reused key in the table resolves in `messages/en.json` at `b6fc3af5d`
  (`github.picker.*`, `onboardingMigrate.connect.*`). No `onboardingMigrate.connect.existing.*` key
  exists yet — expected; MOTIR-8759 writes them.
- **Criteria this changes:** Revision 7 § _Behaviour_ 1 ("2b/2h: Connect GitHub is the only way
  out of the pre-flight") and its "the step's empty state is the pre-flight" now hold **only when the
  accounts read lists no account** (2n); with accounts listed, the list leads (behaviour 2 above).
  Amended here rather than in Revision 7, which stays a record. In code,
  `ConnectPanel.tsx`'s `preflight` case, `tests/components/onboarding-connect-step.test.tsx` and
  `tests/e2e/regression-onboarding-github-connect.spec.ts` assume the pre-flight on arrival; they
  remain true for the no-account case and are MOTIR-8762's to extend, not to rewrite.

## Non-blocking index states (2026-10-16 · MOTIR-8767 · Story MOTIR-8246)

**Design system — files read:** root `package.json` (`"@motir/design-system": "workspace:*"`),
`app/globals.css` (line 13 `@import '@motir/design-system/theme.css'`),
`packages/design-system/package.json` (**`0.15.1`**, exports `./mock`), `app/layout.tsx` (the
`data-style` / `data-palette` / `data-type` axes). No `DESIGN.md`. **Verdict: ON MOTIR DESIGN —
branch (a).** The mock is built with `renderMock` from the package's real `Button`,
`buttonVariants`, `Card` and `Spinner` (the last only in the unchanged reference panel H), axes
`warm-editorial` · `motir` · `motir`, every frame a `[data-appearance-scope]` carrying `data-theme`.
`BrandMark` comes from `@motir/brand` with `brand.css` inlined; the GitHub mark is
`components/icons/GithubMark.tsx` verbatim. Nothing is proposed for the package: the chip, the
detail, the generate notice and the drawer row are **product-local components** (one surface each,
onboarding- or drawer-specific).

**Amends:** § _2026-10-12 — the vibe layout on the migrate wizard_ → **Revision 2** (§ _The indexing
chip and its detail — per element_, § _Behaviour the board depicts_, § _Slot → key (Revision 2)_),
as drawn in [`onboarding-migrate--vibe-layout.mock.html`](./onboarding-migrate--vibe-layout.mock.html)
Panels **3a, 3b, 3c, 4, 5, 9c and 10** — and, through Revision 2, **MOTIR-930's Panel 3 (the Index
step's waiting screen)**, which stays removed. **Delta mock:**
[`index-nonblocking--delta.mock.html`](./index-nonblocking--delta.mock.html). No earlier mock is
edited. Where Revision 2 and this section disagree, this section wins.

**Composes, never re-draws:** the plan window's indexing banner, **MOTIR-4825**
([`design/ai-chat/reading-and-handoff.mock.html`](../ai-chat/reading-and-handoff.mock.html) Panel 7,
shipped as `planningWorkspace.indexing.*`) — **the source of the shared wording and state names**;
and the restyled chrome of the restyle story (MOTIR-8251 / MOTIR-8254: `OnboardingWizardBar`, the
rail, `WarmButton`'s `--el-cta-warm`). The plan window's wait state is not drawn here.

**Shipped reality read this run:** `app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx`
(the bar, `Rail` / `RailStep`, `ImportPanel`, `QuestionsPanel`, `DraftingCard`, `ReadyCard`),
`app/api/onboarding/migrate/[id]/index-status/route.ts`, `lib/dto/migrateOnboarding.ts`
(`MigrateIndexStatusDto`), `app/(authed)/_components/NotificationRow.tsx` (the actorless arm of
`code_access_refused`), `messages/en.json` + `zh.json` (`planningWorkspace.indexing.*`,
`onboardingMigrate.index.*`, `onboardingMigrate.questions.*`, `notifications.summary.*`), and the
sibling cards MOTIR-8768 (the four states), MOTIR-8769 (retry and its refusals), MOTIR-8772 and
MOTIR-8775.

### What changes against Revision 2, and why

1. **The wording is the plan window's, not a second dialect.** Revision 2's chip said _Reading your
   code · 33%_. The banner (MOTIR-4825) already says **Indexing {repos}** with the tails **Queued** /
   **In progress**, and **I couldn't index {repos}** when it failed. The chip now says exactly that,
   by the same keys, so the product names one wait one way.
2. **No percentage, no bar for one repository.** The banner's rule holds here for the same reason:
   motir-core is told an index SUCCEEDED, never how far along it is. The only progress figure the
   read carries is `indexedCount` of `total`, so it appears only with **several** repositories (the
   chip's `1 of 3 done`, the detail's aggregate line). Revision 2's 6 px bar is dropped.
3. **The quiet cue is the banner's three dots, not a `Spinner`.** Pulsing for _indexing_, still for
   _queued_; `prefers-reduced-motion` stills them too. The only spinner on the board is a busy
   **Try again** button and the shipped drafting card (H), both real work in flight.
4. **The generate step gets a notice** (Revision 2 drew only the Decision note): panels F and G.
5. **Plan ready** is drawn in both places (I).

### Panels (light AND dark each)

| panel | what it draws                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | **The access path.** Import step, chip first in the bar's control group, detail closed. Rail: Import current, Index a background row.           |
| B     | The detail open, anchored under the chip (popover). Close / Escape / outside click close it.                                                    |
| C     | The chip's looks, one repository: queued · indexing · focus-visible · done · done fading · failed.                                              |
| D     | Several repositories, mixed: chip `Indexing 3 repositories · 1 of 3 done`; failed wins (`· 1 failed`); two details itemising them.              |
| E     | Retry: idle · in flight (busy, disabled) · back to Queued · refused 409 · refused 422 · errored.                                                |
| F     | Generate step, graph not ready, index queued/indexing: the notice. No spinner, no `aria-busy`, no bar. **Continue into your project**.          |
| G     | Generate step, index failed: _Your plan is waiting on a working index_, the per-repo retry row, Continue (secondary).                           |
| H     | Reference, graph ready: the shipped `DraftingCard`, **unchanged**; the chip has left the bar.                                                   |
| I     | Plan ready: in onboarding the shipped `ReadyCard` (**nothing added above it**); elsewhere the `plan_ready` drawer row, EN and ZH.               |
| J     | Chinese: chip looks, a mixed detail with a refusal, both generate notices.                                                                      |
| K     | Narrow 390: the chip as an icon with a state dot (closed), the detail as a bottom sheet over the scrim (open, failed), and the four dot states. |

### Every state and its trigger (`GET …/index-status`, as MOTIR-8768 shapes it)

Per repository, `repos[i].status` ∈ `queued | indexing | indexed | failed`; aggregate `total`,
`indexedCount`, `failedCount`, `allIndexed`. The chip's state is derived in this order — **one**
function, used by the chip, the narrow dot and the rail row:

| state (chip · dot · rail)  | trigger                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **failed**                 | `failedCount > 0` (wins over everything else)                                                                                                              |
| **done** → then **absent** | `allIndexed === true`: shown on the first read that says so, announced once, gone after ~4 s; never drawn when the wizard mounts on an already-indexed run |
| **indexing**               | any `repos[i].status === 'indexing'`                                                                                                                       |
| **queued**                 | otherwise (every repo `queued`, or some `indexed` and the rest `queued`)                                                                                   |
| single vs multi            | `total === 1` names the repository; `total > 1` counts (`Indexing {n} repositories · {indexedCount} of {total} done`)                                      |
| detail row chips           | `repos[i].status` verbatim: `indexed` mint · `indexing` sky + dots · `queued` muted · `failed` danger surface                                              |
| retry busy                 | the `POST …/index-retry` request is in flight                                                                                                              |
| retry → queued             | that request answered `200 { status: 'queued' }` (next read also says `queued`, MOTIR-8769)                                                                |
| retry refused (409)        | `not_connected`                                                                                                                                            |
| retry refused (422)        | `refused_too_large` (a size-refused repo reads `failed`; the retry is how the person learns why)                                                           |
| retry errored              | any other non-2xx or a network failure                                                                                                                     |
| generate notice (F)        | `run.step === 'generate' && !run.codeGraphReady && failedCount === 0` (includes "status not loaded yet")                                                   |
| generate failed (G)        | `run.step === 'generate' && !run.codeGraphReady && failedCount > 0`                                                                                        |
| generate unchanged (H)     | `run.codeGraphReady === true` → shipped `DraftingCard`                                                                                                     |
| plan ready, onboarding (I) | the run re-read returns step `review` → shipped `ReadyCard`                                                                                                |
| plan ready, elsewhere (I)  | a `plan_ready` notification row (MOTIR-8770 emits, MOTIR-8775 renders)                                                                                     |

The chip is mounted on every step after `index` and disappears once `allIndexed` holds; it never
changes the step underneath.

### Per element — colour + shape role

| element                                                          | colour                                                                                                                                                                                                                                                                                                              | shape / size                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| chip (`button`, `aria-expanded`, `aria-controls="index-detail"`) | `Button secondary sm` on `--el-page-bg`, border `--el-border-strong`; open: `--el-surface`; title `--el-text`, tail `--el-text-secondary`                                                                                                                                                                           | `--radius-btn`, `--height-btn-sm`; max 22rem, the repo name truncates first, the tail never |
| chip — failed                                                    | border `--el-danger-on-surface`, glyph `CircleAlert` + tail `--el-danger-on-surface`; title stays `--el-text`                                                                                                                                                                                                       | as above                                                                                    |
| chip glyph — indexing · queued · done                            | three 5 px dots `--el-accent-on-surface` pulsing · `--el-text-secondary` still · `CheckCircle2` `--el-success`                                                                                                                                                                                                      | `rounded-full` dots                                                                         |
| chip label                                                       | inside `aria-live="polite"`: a state change is announced, never focused                                                                                                                                                                                                                                             | `text-xs`                                                                                   |
| chip focus-visible                                               | `--focus-ring-color` ring, offset on `--el-surface`                                                                                                                                                                                                                                                                 | ring-2                                                                                      |
| narrow chip (390)                                                | `FileCode2` `--el-text`; dot `--el-text-secondary` / `--el-accent-on-surface` / `--el-success` / `--el-danger-on-surface`, ring `--el-page-bg`; the full label is its `aria-label`                                                                                                                                  | `--radius-control`, `p-(--spacing-icon-btn)`; dot `size-2.5` `rounded-full`                 |
| detail (`role="dialog"`, `data-surface="popover"`)               | `--el-page-bg`, border `--el-border`, `--shadow-elevated`                                                                                                                                                                                                                                                           | `--radius-card`, `--spacing-card-padding`, 380 px                                           |
| detail as bottom sheet (390)                                     | as above over `--el-overlay-scrim`; grab handle `--el-border-strong` (decorative)                                                                                                                                                                                                                                   | `--radius-modal`, full width, bottom edge flush                                             |
| title · Close · body · aggregate · heading                       | `--el-text` semibold · `Button ghost sm` · `--el-text-secondary` · `--el-text-secondary` (only when `total > 1`) · `--el-text-secondary` caps                                                                                                                                                                       | —                                                                                           |
| repo row                                                         | border `--el-border-soft`; `GithubMark` `--el-text-secondary` (sr-only "GitHub"); owner `--el-text-secondary`, name `--el-text`, mono                                                                                                                                                                               | `--radius-control`, `--spacing-control-x`                                                   |
| row state chips                                                  | `--el-tint-mint` / `--el-tint-sky` + `--el-text-strong`; `--el-muted` + `--el-text-secondary`; `--el-danger-surface` + `--el-danger-on-surface`                                                                                                                                                                     | `--radius-badge`, `--spacing-chip-x/y`                                                      |
| failed row · its sentence                                        | border `--el-danger-on-surface` · `--el-text-secondary`                                                                                                                                                                                                                                                             | as row                                                                                      |
| Try again · Check the connection                                 | `Button secondary sm` + `RotateCcw` (busy: `loading`, disabled, `aria-busy`) · `Button ghost sm` link → `/settings/organization/git`                                                                                                                                                                                | `--radius-btn`, `--height-btn-sm`                                                           |
| refusal sentence                                                 | `--el-danger-on-surface` + `CircleAlert`, `role="alert"`                                                                                                                                                                                                                                                            | `text-xs`                                                                                   |
| rail Index background row                                        | marker ring `--el-border`, dots / `CircleAlert` as the chip; label `--el-text`, meta `--el-text-secondary`; never `aria-current`                                                                                                                                                                                    | `size-5`, `--radius-control`                                                                |
| generate notice (`Card`, `role="status"`)                        | icon disc `--el-tint-sky` + `--el-text-strong` (`BookOpenText`, static); heading `--el-text-strong`; body `--el-text-secondary`; state line `--el-text-secondary`; Continue = `WarmButton` (`--el-cta-warm` / `--el-cta-warm-text`)                                                                                 | `--radius-card`; disc `rounded-full`                                                        |
| generate notice — failed                                         | disc `--el-danger-surface` + `--el-danger-on-surface` (`CircleAlert`); the failed repo row as above; Continue `Button secondary md`                                                                                                                                                                                 | as above                                                                                    |
| `plan_ready` drawer row                                          | the actorless arm of `NotificationRow`: glyph `ListChecks` in the avatar slot, fill `--el-notif-plan-ready` (**new Tier-3 token for MOTIR-8775, mapped to `--color-success`**; drawn as `--el-success`), glyph `--el-accent-text`; summary `--el-text`, project bold `--el-text-strong`, time `--el-text-secondary` | as shipped                                                                                  |

No `--el-text-muted`, no `--el-text-faint` text, no `--el-danger-text`, no raw colour. The dots'
pulse is the only `<style>` rule the mock adds besides `brand.css`.

### Behaviour

1. **Access path.** The chip sits first in the bar's control group, before _Start from an idea
   instead_; at 390 the icon takes that slot and the flow name is not shown. Click / Enter / Space
   opens the detail (popover on desktop, bottom sheet at 390); Close, Escape, an outside click (or a
   tap on the scrim, or a downward swipe) closes it and returns focus to the chip.
2. **One read.** Chip, dot, rail row and generate notice read the one `index-status` poll the wizard
   already runs; it stops once `allIndexed` holds.
3. **Retry is one mechanism**, shown in the detail's failed row and in the generate notice's failed
   variant (MOTIR-8772 extracts it rather than copying it).
4. **The generate notice never advances.** It re-reads the run; on `codeGraphReady` it hands over to
   the shipped `DraftingCard`, on step `review` to the shipped `ReadyCard`, without a reload.
5. **Continue into your project** goes where _Save & exit_ goes (`saveExitHref`), so the run stays
   active and the sweep finishes the job.

### Slot → key (proposed — `messages/` is not edited here)

**Reused, unchanged:** `planningWorkspace.indexing.title` (`Indexing {repos}` · `正在索引 {repos}`),
`.chipQueued` (Queued · 排队中), `.chipRunning` (In progress · 进行中), `.failedTitle`
(`I couldn't index {repos}` · `我没能索引 {repos}`), `.retry` (Try again · 重试);
`onboardingMigrate.index.heading` (detail title), `.aggregate`, `.perRepo`, `.state.indexed`,
`.state.queued`; `onboardingMigrate.questions.*` (H, I); `common.saveExit`.

| slot                         | key (NEW unless marked)                                 | English                                                                                                                                                 | 中文                                                                                                           |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| chip — done                  | `onboardingMigrate.indexing.doneTitle`                  | Indexed {repos}                                                                                                                                         | 已索引 {repos}                                                                                                 |
| {repos} with several         | `onboardingMigrate.indexing.repoCount`                  | {count, plural, one {# repository} other {# repositories}}                                                                                              | {count} 个仓库                                                                                                 |
| chip tail — multi            | `onboardingMigrate.indexing.aggregateTail`              | {done} of {total} done                                                                                                                                  | 已完成 {done} / {total}                                                                                        |
| chip tail — failed (multi)   | `onboardingMigrate.indexing.failedTail`                 | {count} failed                                                                                                                                          | {count} 个失败                                                                                                 |
| narrow chip name suffix      | `onboardingMigrate.indexing.openDetail`                 | Index status — open details                                                                                                                             | 索引状态——打开详情                                                                                             |
| detail body                  | `onboardingMigrate.indexing.detailBody`                 | This keeps going in the background, so carry on. Only drafting your plan waits for it, and that starts by itself when indexing finishes.                | 它在后台继续运行，你可以接着往下走。只有起草计划需要等它，索引完成后会自动开始。                               |
| row chips                    | `onboardingMigrate.index.state.indexing` · `.failed`    | In progress · Failed                                                                                                                                    | 进行中 · 失败                                                                                                  |
| failed row sentence          | `onboardingMigrate.indexing.rowFailed`                  | Motir couldn't index this repository. Nothing you've done is lost.                                                                                      | Motir 没能索引这个仓库。你已完成的步骤都不会丢失。                                                             |
| Check the connection · Close | `onboardingMigrate.indexing.checkConnection` · `.close` | Check the connection · Close                                                                                                                            | 检查连接 · 关闭                                                                                                |
| retry busy                   | `onboardingMigrate.indexing.retrying`                   | Trying again…                                                                                                                                           | 正在重试……                                                                                                     |
| refusal 409                  | `onboardingMigrate.indexing.refusedNotConnected`        | This repository isn't connected to the project any more. Check the connection, then try again.                                                          | 这个仓库已不再连接到该项目。请先检查连接，再重试。                                                             |
| refusal 422                  | `onboardingMigrate.indexing.refusedTooLarge`            | This repository is too large for Motir to index.                                                                                                        | 这个仓库太大，Motir 无法为它建立索引。                                                                         |
| retry error                  | `onboardingMigrate.indexing.retryError`                 | Motir couldn't start that again. Try once more in a moment.                                                                                             | Motir 没能重新开始。请稍后再试一次。                                                                           |
| rail sub-line                | `onboardingMigrate.rail.sub` (shipped, unchanged)       | Indexing runs in the background — leave and come back.                                                                                                  | 索引在后台运行——你可以离开再回来。                                                                             |
| rail Index meta              | `onboardingMigrate.rail.indexBackground`                | In the background · {state}                                                                                                                             | 在后台 · {state}                                                                                               |
| notice heading               | `onboardingMigrate.generateWaiting.heading`             | Your plan is drafted as soon as Motir has read your code                                                                                                | Motir 读完你的代码后，会立即起草你的计划                                                                       |
| notice body                  | `onboardingMigrate.generateWaiting.body`                | Motir is still indexing {repos}. You don't have to wait here: go on into your project, and you'll get a notification when your plan is ready to review. | Motir 仍在索引 {repos}。你不必在这里等：直接进入你的项目，计划可以审阅时你会收到通知。                         |
| notice state line            | `onboardingMigrate.generateWaiting.state`               | Indexing {repos} · {state}                                                                                                                              | 正在索引 {repos} · {state}                                                                                     |
| Continue                     | `onboardingMigrate.generateWaiting.continue`            | Continue into your project                                                                                                                              | 进入你的项目                                                                                                   |
| failed heading               | `onboardingMigrate.generateWaiting.failedHeading`       | Your plan is waiting on a working index                                                                                                                 | 你的计划在等待一个可用的索引                                                                                   |
| failed body                  | `onboardingMigrate.generateWaiting.failedBody`          | I couldn't index {repos}, so there is nothing to draft from yet. Nothing you've done is lost. Try again, or carry on and come back to it.               | 我没能索引 {repos}，所以暂时没有可以起草的依据。你已完成的步骤都不会丢失。可以重试，也可以先继续，稍后再回来。 |
| drawer row                   | `notifications.summary.planReady`                       | Your first plan for <s>{project}</s> is ready to review                                                                                                 | <s>{project}</s> 的第一份计划已可审阅                                                                          |

**Retired with the stop** (if nothing else reads them): `onboardingMigrate.index.eyebrow`, `.body`,
`.building`, `.waiting`, `.callout`, `.completeTitle`, `.completeNote`, `.next`, and
`questions.draftingWaits` (MOTIR-8772 checks with `git grep`). Revision 2's proposed `indexing.queued/.running/.done/.failed`, `indexing.detailTitle`,
`indexing.failedBody` and `rail.indexQueued/.indexFailed` are **superseded** by the table above.
Its **Decision note** (Panel 5, `decision.waitNote` / `.failedNote`) is **not redrawn and stands as
drawn there**; it is not in this story's scope.

**Chinese length.** The chip's widest Chinese label (`正在索引 3 个仓库 · 已完成 1 / 3`) fits
`--height-btn-sm` on one line in panel J; the repository name truncates before the tail.

### Findings

- **F1 — `index-status` carries no reason for a failure.** A size-refused repo and a crashed index
  both read `failed`, so the detail offers Try again on both and the 422 sentence is how a person
  learns about size. A `failedReason` on the row would let the detail say it up front; not built
  here, and not needed for this story's acceptance.

### GIVES / TAKES

- **MOTIR-8771 (indicator)** — **GIVES** panels A–E, J, K: the chip, the narrow icon, the detail /
  sheet, the retry states, the derivation order and the keys above. **TAKES** Revision 2's
  _Reading your code · 33%_ wording and its progress bar.
- **MOTIR-8772 (generate notice)** — **GIVES** panels F, G, H, I (onboarding half) and the
  `generateWaiting.*` keys; `ReadyCard` gets **no** banner line.
- **MOTIR-8775 (notification type)** — **GIVES** the drawer row of panel I and the
  `--el-notif-plan-ready` → `--color-success` mapping.
- **MOTIR-8769 (retry)** — given nothing to build; its 409 / 422 / generic answers each have a
  sentence here.
- **MOTIR-8774 (E2E)** — **GIVES** the walk: A → B → C (done fades) → F → I, and G → E in English
  and Chinese.

## Non-blocking index states — Revision A: enter Motir while indexing and importing run (2026-10-16 · MOTIR-8767 · Story MOTIR-8246)

**Why this revision.** Mo sent the first version back on 2026-10-16:

> we don't create a plan if we don't know what the user wants to build next. And i don't see why
> the questions are asked, so "A few questions" can be removed. Give the user a button and the user
> can enter the Motir even the indexing is not finished, and we don't let the user wait for the
> work items import either, those 2 jobs can run in the background

**Amends:** § _Non-blocking index states_ (above) and its delta mock
[`index-nonblocking--delta.mock.html`](./index-nonblocking--delta.mock.html). **Delta mock:**
[`index-nonblocking--enter-motir.mock.html`](./index-nonblocking--enter-motir.mock.html), built with
the same generator parts as the first delta (`renderMock`, the package's real `Button` and `Card`,
`BrandMark`, axes `warm-editorial` · `motir` · `motir`, light and dark per panel). Nothing is
proposed for the design-system package. Where this revision and the section above disagree, this
revision wins.

### What changes

- **The wizard ends at the Import step with one primary action, _Enter Motir_.** It is enabled
  whatever the index reads (queued, in progress, indexed or failed) and whatever the import is doing.
  It replaces _Skip for now_: entering without importing is skipping.
- **The import runs in the background too.** Starting one no longer holds the step: the card shows
  a status line for the running import, the source tiles go inert (`aria-disabled`, dimmed) while one
  runs, and the rail shows _Import work items_ as a second background row beside _Index_.
- **No plan is drafted in onboarding.** The rail's _Your direction_ group and its _A few questions_
  step are removed, and so is everything that existed only to draft a plan: the generate-step notice
  and its failed variant (panels F and G above), the drafting reference (H), and the plan-ready
  moment in onboarding and in the drawer (I).
- **The detail lists both background jobs.** Its body copy no longer mentions a plan, and while an
  import runs it gains a _Work items import_ group under _Per repository_.

**Unchanged from the section above:** the chip and its every look (panels A, C, D), the detail's
per-repository rows, the failed state and its retry with every refusal (E), and the narrow layout (K),
apart from the detail body copy, which every panel now reads from the new key below.

### Panels (light AND dark each)

| Panel | What it shows                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------- |
| A     | Import step after connect, nothing imported, index in progress: _Enter Motir_ is the primary.   |
| B     | An import running (Jira, 40 of 120): status line, inert tiles, Import as a background rail row. |
| C     | The chip's detail open with both jobs: the repository row and the _Work items import_ row.      |
| D     | The index failed: the chip reads failed, _Enter Motir_ stays enabled.                           |
| E     | Chinese: panel B and the detail at their longer length.                                         |

### Per element — colour + shape role

| Element                        | Colour                                                                | Shape                                                           |
| ------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| _Enter Motir_                  | `Button` primary (`--el-accent` fill, `--el-accent-text`)             | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x/y`          |
| Hint beside it                 | `--el-text-secondary` on the card                                     | —                                                               |
| Footer divider                 | `--el-border-soft`                                                    | —                                                               |
| Import status line             | `--el-tint-sky` fill, `--el-text-strong` text, accent dots            | `--radius-control`, `--spacing-control-x`                       |
| Inert source tiles             | unchanged inks, whole row at 60% opacity                              | unchanged                                                       |
| Rail import background row     | as the Index background row: `--el-border` ring, dots, secondary meta | `--radius-control`                                              |
| Detail _Work items import_ row | `--el-border-soft` border, `--el-text`; chip `--el-tint-sky` + strong | `--radius-control`; chip `--radius-badge`, `--spacing-chip-x/y` |

Every text ink is `--el-text`, `--el-text-strong` or `--el-text-secondary`; nothing uses
`--el-text-muted` or `--el-text-faint`.

### Behaviour

- **_Enter Motir_ finishes onboarding.** It completes the run (`step: 'done'`,
  `status: 'completed'`, the terminal shape a walked run already has) and goes to the project. The
  index and any import keep running; nothing about either job changes.
- After entering, the index state is where shipped surfaces already show it (the plan window's
  indexing banner, MOTIR-4825, and the repository settings). Nothing new is drawn inside the app.
- The retry (MOTIR-8769's `POST …/index-retry`) is reached from the chip's detail exactly as before.

### Slot → key (proposed — `messages/` is not edited here)

| Slot                       | Key                                         | en                                                                                                          | zh                                                                                |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Primary action             | `onboardingMigrate.enter.cta`               | Enter Motir                                                                                                 | 进入 Motir                                                                        |
| Hint beside it             | `onboardingMigrate.enter.hint`              | Indexing and any import keep going after you enter.                                                         | 进入之后，索引和导入会继续进行。                                                  |
| Rail subtitle              | `onboardingMigrate.rail.subtitle`           | Indexing and importing run in the background. Enter Motir whenever you like.                                | 索引和导入都在后台运行。你随时可以进入 Motir。                                    |
| Import step body           | `onboardingMigrate.import.body`             | Import from Jira, Linear or Plane, or enter Motir and do it later. An import keeps going in the background. | 从 Jira、Linear 或 Plane 导入，或者先进入 Motir，以后再做。导入会在后台继续进行。 |
| Import status line         | `onboardingMigrate.import.running`          | Importing from {source} · {done} of {total} work items                                                      | 正在从 {source} 导入 · 已完成 {done} / {total} 个工作项                           |
| Import status line, second | `onboardingMigrate.import.runningBody`      | This keeps going in the background. You don't have to wait for it.                                          | 它在后台继续运行，你不必等它完成。                                                |
| Detail body (replaces)     | `onboardingMigrate.indexing.detailBody`     | This keeps going in the background. You can enter Motir now; nothing waits for it to finish.                | 它在后台继续运行。你现在就可以进入 Motir，没有任何步骤需要等它完成。              |
| Detail import group        | `onboardingMigrate.indexing.importHeading`  | Work items import                                                                                           | 工作项导入                                                                        |
| Detail import row state    | `onboardingMigrate.indexing.importProgress` | {done} of {total}                                                                                           | {done} / {total}                                                                  |

**Retired by this revision:** every `onboardingMigrate.generateWaiting.*` key and the plan-ready
copy proposed above.

### What this means for the code cards (for the re-plan Mo asked for)

This revision removes plan generation from onboarding, so the story's cards that draft or announce a
plan no longer match the design: MOTIR-8770 (start generation when the graph is built, notify plan
ready), MOTIR-8772 (the generate-step notice and plan-ready notice), the `plan_ready` notification
type already built under MOTIR-8775, and the parts of MOTIR-8773 / MOTIR-8774 that test them. Ending
the wizard at Import, removing the discovery step and backgrounding the import are not covered by any
card yet. MOTIR-8768 (the index step no longer waits) and MOTIR-8769 (retry) stand as built, and
MOTIR-8771 (the chip and detail) stands with the detail changes above.

### GIVES / TAKES

- **GIVES** the wizard's end state as one primary action that never waits, and the detail's import
  group.
- **TAKES** the chip, detail, failed state and retry from § _Non-blocking index states_, and the
  index and retry reads from MOTIR-8768 and MOTIR-8769.
