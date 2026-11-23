# Code — the surface, and the rule underneath it

**Story [MOTIR-1754] · design subtask [MOTIR-1764]. Repo `motir-core`.**
Asset set: `design/code-context/design-notes.md` + `code-context.mock.html` + `code-context.png`

- `code-context.dark.png`.

> ## ⚠️ AMENDED 2026-09-07 (second) — THERE IS NO `Index` TAB; the `Code` row is TWO sections
>
> **Yue: _"index tab should not be there."_** The row is **Repositories → Health**.
>
> The freshness states are not deleted and nothing about what they SAY changes — they move onto the
> **repository row**, which is where the shipped `RepositoryInventory` already renders the index pill.
> **A tab is a room somebody goes to, and nobody goes to look at an index**: they arrive with a
> question about ONE repository, and the answer belongs on that repository's row. §4 carries the
> argument and the panel dispositions.
>
> It also removes a hazard the three-tab shape carried: a separate Index room is a SECOND surface
> drawing the same four states, and two surfaces rendering one derivation is precisely what
> `lib/codeGraph/indexState.ts` is guarded to prevent.

> ## ⚠️ AMENDED 2026-09-07 — the registers adopt the SHIPPED vocabulary, and the row composes
>
> The 2026-09-05 rework below stands in full. Two corrections on top of it, both forced by substrate
> that shipped underneath this asset while it sat in review:
>
> 1. **The fourth state is `Indexed`, not `Current` (§4.1).** [MOTIR-4724] shipped
>    `lib/codeGraph/indexState.ts` as the ONE derivation, and its four states are
>    `never · indexing · indexed · stale`. `indexed` deliberately makes no currency claim: a
>    repository nobody has pushed has no head sha to be compared against, and — because a push
>    webhook is the column's **only** writer — it never acquires one, so the overclaim would be
>    permanent and aimed at exactly the repositories whose graphs are oldest. **This contradicts
>    what ships today**, which renders `Current`; the disagreement is argued out in §4.1 and
>    [MOTIR-4817] carries the fix.
> 2. **The repository row COMPOSES `RepositoryInventory` (§4.2)** rather than being drawn a second
>    time — the same row and the same pill, with the org-only affordances (`Used by N projects`,
>    `Disconnect`) absent and the drift and indexed sha added.
>
> Panel F keeps the word _current_ in one place, deliberately: a refresh that has just run has
> **observed** the two shas equal, so there currency is measured rather than assumed.

> ## ⚠️ REWORKED 2026-09-05 — the surface COLLAPSES and the tenancy rule changes
>
> This asset's first revision drew the freshness signal across two hosts — `/planning` and
> `/code-health` — with git left where it was, in the rail's bottom section. **That split is
> superseded, not restyled**, on two directions from Yue:
>
> 1. **Code health, the code index and git collapse into ONE left-nav row.** They were in two
>    different rail sections with opposite gating, and the code index had no surface at all.
> 2. **Visibility is per PROJECT; the code graph is shared per ORGANISATION.** A repository
>    connected to one project is not visible in another, and connecting one that another project in
>    the same organisation already uses does **not** index it again. _"The separation is about
>    visibility, not individual index."_
>
> **What SURVIVES from the first revision, unchanged and still drawn:** every freshness state
> (panels A–H), drift stated in COMMITS rather than as an age, `stale` and `indexing` kept apart with
> wait-and-return language belonging to `indexing` alone, the §10.3 aside anatomy inherited for the
> connect case, and the `localStorage` dismissal correction. Those were about _what the states say_;
> the rework is about _where they live and who can see them_.
>
> **What is SUPERSEDED:** the two-host split (panels 0 and E of the first revision), and the
> assumption that the repo set a project renders is the workspace installation's.

Three things were in two places with opposite gating, and one of them had no place at all:

|                 | where it was                                       | who could reach it               |
| --------------- | -------------------------------------------------- | -------------------------------- |
| **Code health** | primary project row → `/code-health`               | gated on `ai:configure` — admins |
| **Git**         | rail BOTTOM section → `/settings/workspace/github` | deliberately **ungated**         |
| **Code index**  | nowhere                                            | —                                |

They collapse into a single primary **Code** row with **TWO** sections, in the order a user meets
them: **Repositories → Health**. You connect, and it is audited.

**⚠️ THE INDEX IS NOT THE THIRD SECTION — it is a PROPERTY OF A REPOSITORY, and §4 says why.** The
table's third row is real: the code index had no place at all. Giving it a TAB was the wrong answer
to that, because a tab is a room you go to and the index is never a thing a person visits — it is a
fact about each repository, which the repository row already carries.

---

## 1. ⚠️ The rule underneath the surface — the repository belongs to the ORG

Everything below is a consequence of this, so it is stated first, in Yue's own framing.

- **A repository belongs to the ORGANISATION, and the organisation is the accounting unit.**
  ⚠️ _Accounting_, not _billing_: Motir does **not charge** for code indexing. It draws on a separate
  **index allowance** included in the org's tier, which the customer never sees — so the cost is real
  and the org bears it inside the tier price, a hidden cost rather than a hidden charge. Use
  _attributed · accounted · internal COGS · index allowance_ (MOTIR-4541).
- **So there is no privacy question between projects of one org**, and this design does not draw an
  isolation boundary. An **org admin can pull any of the org's repositories into any project — in the
  same workspace or a different one.**
- **One repository has ONE code graph, built once, shared across the org.** Adding a repository to a
  second project rebuilds nothing.
- **The per-project list is therefore VISIBILITY CONFIGURATION** — which repositories _this_ project
  works on, so its planner reads the right code and its surfaces are not a directory of everything
  the org owns. It is relevance, not secrecy, and **the copy must never imply otherwise.**

**The counterfactual is what settles it, and it is worth writing down because it is the argument
rather than the conclusion:** _if a repository did not belong to the org, the index would have to be
maintained per project_ — the same graph rebuilt N times, drawing the org's index allowance N times
**and** Motir's own container time N times, for byte-identical output. **That is the wrong design**,
and it costs both sides. Not needing it is why the graph is org-keyed.

**⚠️ The dedup boundary is the ORG, not the repository.** Two DIFFERENT orgs that each connect the
same repository — a shared dependency, a public repo — are indexed **twice**, once per org, and that
is correct rather than wasteful. The org is the isolation boundary and a global `repoRef`-keyed graph
would cross it. Nobody may "optimise" this into a single global index.

**Two readings that follow, and both are copy rules:**

- A repository the org already indexed reads **`current` the moment it is added to a project** — not
  `indexing`. There is no fifth verdict; the graph exists. **Copy must never say _"indexing…"_ for a
  repository that is already indexed**, which is a wait for an event that will not happen — the same
  failure panel D exists to prevent, one surface over.
- A repository absent from a project's list is absent because **nobody configured it there**, not
  because it is hidden. Panel S's copy says exactly that.

### 1.1 ⚠️ This is NOT what ships today — the tenancy audit

A tenancy change is a schema audit rather than a policy tweak, so here is the audit. Read on
`origin/main`:

|                               | today                                                                   | what this asset assumes                                                             |
| ----------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| the graph's key               | `CodeRepo @@unique([aiProjectId, repoRef])` — **one graph per project** | one graph per `(organisation, repoRef)`                                             |
| the graph's cascade           | `onDelete: Cascade` from `AiProject` — deleting a project drops a graph | cascades from the org; a project leaving cannot drop a graph others use             |
| the planner's repo set        | `resolveCodeContext` → `listByInstallation` — the **workspace's** repos | the **project's** configured set                                                    |
| indexing                      | `codeGraphIndexService` fans out to **every project of the workspace**  | once per repository, per org                                                        |
| a repo in two projects        | **inexpressible** — `ProjectRepo.githubRepoId` is `@unique`             | the ordinary case                                                                   |
| the repo's own tenancy column | `GithubRepo.workspaceId` (MOTIR-1931) — workspace grain                 | the org owns the repository; workspace must not constrain which projects may use it |
| the isolation test            | MOTIR-1765 asserts _project A cannot read project B's row_              | the boundary is the **ORG**; that assertion is about the wrong tenant               |

The `@unique` row is the one that blocks the model outright, and it is a one-line schema fact rather
than a judgement: _"connect a repo to a second project"_ is currently inexpressible.

**None of that is this card's to build.** The tenancy move is its own story; [MOTIR-2029]'s decision
record is where it is argued and now decided. This asset draws the surface that model produces and
says plainly which of its states are unreachable until the model lands.

## 2. THE DOOR — one row, and one row leaves

**`Code`, a primary project row**, where `Code health` was. The rail's bottom section loses **`Git`**.

⚠️ **THE RAIL IS COMPOSED, NOT REDRAWN.** Its design of record is
`design/shell/rail-bottom-section.mock.html` + `design/shell/design-notes.md` § _The rail's bottom
section_, which enumerates the four rows that section carries and states its FLOOR as _Job runs ·
Git_. **After this, that floor is `Job runs` alone** — a real narrowing of a section that asset
measured deliberately, so **removing the row is an amendment to THAT asset, in another area, owned by
its own shell design-amendment card.** It is drawn here only so the door is visible; this asset does
not re-specify the rail.

The row order and glyphs drawn here are `app/(authed)/_components/SidebarNav.tsx`'s own.

### 2.1 ⚠️ The gating clash, and why it needed solving rather than picking a side

`/code-health` asserts `ai:configure`. The `Git` row is ungated, and `SidebarNav.tsx` says so on
purpose: _"Job runs and Git are NOT gated on this and must not be."_ The reason is in
`projectSettingsNav.ts` — connecting your own account is _"the one action nobody can take on
[a member's] behalf."_

So a naive collapse fails in one of two directions, and both are unacceptable:

- **one gated row** ⇒ every member loses the connect action — a CAPABILITY removed, which the
  audience rule forbids outright;
- **one ungated row** ⇒ an admin-only audit is widened to everyone, which `aiConventionService`'s own
  comments record as the thing its `ai:configure` mapping deliberately avoided.

**The resolution: the ROW is browse-reachable and each SECTION keeps its own gate.** This costs
nothing to build, because `/code-health` **already** renders an admin-only empty state rather than
refusing — panel H2 composes that state rather than inventing one. Repositories is browse-reachable;
Health is admin-only _inside the page_.

> **AMENDMENT (MOTIR-9173, owner's decision 2026-10-21) — Health is READ by members, WRITTEN by admins.**
> The paragraph above drew Health as admin-only _inside the page_. It no longer is: the audit and the
> coding convention are read with `ai:plan` (the member key, the one `get_code_health` already used), so a
> member sees the whole page, Health included, **read-only** — no convention editor, no re-audit or
> deepen control, no "run first audit" action. Every write (`saveConvention`, `reaudit`) stays
> `ai:configure` and the write routes keep refusing a member. Panel H2's admin-only empty state now
> shows only for a role that holds neither read key (`project:browse` without `ai:plan`).

**The test this has to pass, and panel H2 is drawn to show it passing: nothing a member could do
before is gone.**

---

## 3. REPOSITORIES — and the two different actions behind one old row

> **⚠️ AMENDED 2026-09-07 (MOTIR-4866): THIS SECTION HAS NO ACTION OF ITS OWN.** It read _"The
> primary action is `Add or remove repositories` — a `Button variant="primary"`, not a link"_, and
> drew a member's connect row beside it (§3.1). [MOTIR-1768]'s re-scope moved **both off this page**,
> and this asset absorbed only the first of that re-scope's three removals — §4 retired the `Index`
> tab and §3 was never swept, so the two halves of this document described two different pages.
>
> **The rows are READ-ONLY.** The section's only affordance is a link to
> **Settings → Project → Repositories**.
>
> ⚠️ **§3.1's CAPABILITY RULE IS SATISFIED, NOT WAIVED, and the table below is kept because it is
> the load-bearing part.** Both actions are carried forward — to surfaces that already ship them,
> verified in code rather than assumed:
>
> | action                                                         | where it lives                   | shipped by                            |
> | -------------------------------------------------------------- | -------------------------------- | ------------------------------------- |
> | Configure which repositories this project works on (ORG ADMIN) | `/settings/project/repositories` | `_components/AddRepositoryPicker.tsx` |
> | Connect YOUR OWN account (ANY MEMBER)                          | `/settings/account/git`          | `page.tsx` + `actions.ts`             |
>
> `GithubIdentity` is `userId @unique`, which is why the second is an ACCOUNT-tier surface and not a
> project one. **Nothing a member could do before is gone** — the test §2.1 sets is still passed,
> by a different route than this section originally took.
>
> ⚠️ **AND THE `code-access` CONSEQUENCE BELOW IS CORRECTED, because as written it instructed a
> regression.** It said `/settings/project/code-access`'s `connectHref` _"has to be re-pointed at
> the Code page, or the member's door survives in this design and dies in the build."_ Under this
> scope that is backwards: the Code page has no connect row, so re-pointing there sends a member to
> a door that is not there — the exact capability loss §3.1 forbids, arrived at by following §3.
> **`connectHref` points at Settings → Account → Git.**
>
> **What is struck below:** the primary-action sentence, and the two-destination table's claim to be
> _this section's_ button. **What survives:** why labelling by destination was wrong, which is a real
> finding about that label and now belongs to the surface that owns the button.

**The label names the INTENT, not the destination — a finding that travels with the button to
Settings → Project → Repositories.** `Manage on GitHub` named a _destination_; `Add or remove
repositories` names the _intent_. That matters because the destination is not one place:

| provider   | where the action goes                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------- |
| **GitHub** | GitHub's own installation screen — repository selection is the host's, and Motir cannot perform it |
| **GitLab** | Motir's own project picker — the connection selects projects in-app                                |

**One label, two destinations — which is exactly why labelling by destination was wrong.** A user
looking for _"how do I add a repo?"_ was being asked to know that the answer is spelled _"manage"_ and
lives on another company's website.

**The picker offers every repository the ORG has**, not the workspace's — that is the set an org
admin may configure into any project (§1).

### ⚠️ 3.1 TWO actions lived behind the old `Git` row, and only one of them is this button

This is the capability check the collapse has to pass, and getting it wrong removes something a
member could do before:

| action                                                 | who                                                                                                                                                   | where it goes now                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Configure which repositories this project works on** | **org admin** — it is visibility configuration                                                                                                        | **`/settings/project/repositories`** — `AddRepositoryPicker.tsx` (§3, corrected)               |
| **Connect YOUR OWN account**                           | **any member** — `GithubIdentity` is `userId @unique`, and `projectSettingsNav.ts` calls it _"the one action nobody can take on [a member's] behalf"_ | **`/settings/account/git`** — an ACCOUNT-tier surface, because the identity is (§3, corrected) |

Both reached `/settings/workspace/github`, which is what the `Git` row pointed at. **So removing that
row without carrying BOTH forward removes a capability rather than a concept** — the thing an
audience-preserving move is not allowed to do.

⚠️ **THE RULE IS UNCHANGED; ONLY THE THIRD COLUMN MOVED (MOTIR-4866).** Both are carried forward, to
surfaces that already ship them — so the rule is satisfied by a different route than this section
first took, and the reason to keep this table is that it is the only place a reader can check that
it still is. It used to read _"Panel R draws the admin view and the member view side by side
precisely so the second one cannot be forgotten"_; the second is not forgotten, it is at
Settings → Account → Git, and Panel R no longer draws either.

**A consequence for another surface — CORRECTED 2026-09-07 (MOTIR-4866).**
`/settings/project/code-access` uses `GITHUB_SETTINGS_PATH` as its `connectHref`. It is re-pointed
at **Settings → Account → Git**, which is where the member's own-account connect now lives.
~~_"That link has to be re-pointed at the Code page, or the member's door survives in this design and
dies in the build."_~~ — struck, and struck because it was the more dangerous half: the Code page
carries no connect row, so following it would have produced precisely the dead door it warned about.

**Removing a repository here removes it from THIS project.** It does not delete the org's graph,
which another project may still be using — and the copy says so, because "remove" over a shared asset
is exactly the word that invites the wrong assumption.

## 4. FRESHNESS — a property of the REPOSITORY, not a section of its own

> **⚠️ AMENDED 2026-09-07 (Yue): THERE IS NO `Index` TAB.** This section was _"INDEX — the freshness
> section"_, and the `Code` row carried three tabs. **A tab is a room somebody goes to, and nobody
> goes to look at an index.** They come to answer one question about ONE repository — _can Motir read
> this, and is what it read current?_ — which is a question about the row they are already looking at.
>
> **What that changes:** nothing about WHAT the states say. Every panel below is unchanged — the four
> states, drift in commits, `stale` and `indexing` kept apart, the settled line, the D3 unknown-count
> case. What changes is WHERE they render: **on the repository row in the Repositories section**,
> which is where `RepositoryInventory` already puts the index pill (§4.2) and where MOTIR-4817 just
> corrected its label.
>
> **And it removes a real hazard rather than only a tab.** A separate Index room is a second place the
> same four states are drawn, and two surfaces rendering one derivation is exactly what
> `lib/codeGraph/indexState.ts` exists to prevent — the ONE derivation guarded so _"the organisation
> inventory, the `Code` page and any future surface must not be able to disagree about what the word
> means"_. One fewer surface is one fewer way to disagree.
>
> **The panels below are therefore drawn as ROW STATES and their in-situ home is the Repositories
> section.** They are kept as separate panels because a state gallery is how a design shows four
> states at once; that is a property of the ASSET, not a claim that the product has four screens.

Everything panels C · D · F · G · H draw, rendered on the repository row rather than in a section of
its own. The rules are unchanged from the first revision and are restated here only where the
collapse touches them:

- **Drift is stated in COMMITS, never as an age** (§9 below — unchanged, and still the sharpest point
  in this asset).
- **`stale` and `indexing` are two states and only one is moving** (§10.1 — unchanged).
- **NEW: `already indexed · shared`.** A repository connected here whose graph exists elsewhere in
  the organisation reads `indexed` at once. See §1.

### 4.1 ⚠️ The four states are the SHIPPED ones, and `indexed` is not `current`

`lib/codeGraph/indexState.ts` (MOTIR-4724) is the ONE derivation, and its states are
**`never` · `indexing` · `indexed` · `stale`**. This asset's first two revisions named the fourth
one `current`. It is drawn as **`Indexed`**, and the difference is not a synonym.

**`current` claims the graph matches your code. `indexed` claims only that a graph exists and
nothing has told us it is behind.** The derivation's own header says so, and the gap between the two
is a real population rather than a pedantic one:

- `stale` is reached only when **both** shas are known and differ.
- A missing sha falls through to `indexed` — deliberately, because treating an absent comparand as a
  difference would flip the whole estate to `stale` on deploy.
- **`defaultBranchHeadSha` is written by a push webhook and by nothing else.** Not by connect, not by
  the index handoff (`lib/jobs/indexRepoRow.ts` only _reads_ it; the index run read it the same way before MOTIR-12041 retired it). So a connected, indexed repository
  that receives no push never acquires a head sha at all.

⚠️ **That makes the overclaim permanent, and pointed at the wrong repositories.** A busy repository
gets a real head sha within minutes and reports honestly ever after. The repository that would
permanently read _"Current"_ is the quiet one — precisely the one whose graph is most likely to be an
old snapshot taken before the column existed.

**One exception, drawn in panel F.** The settled line may say _"now current at `9c14e02`"_, because a
refresh has just run and observed the two shas equal. Currency is legitimate where it was measured;
it is not legitimate as a resting label.

**⚠️ This CONTRADICTS what ships today, and the disagreement is recorded rather than papered over.**
`app/(authed)/settings/organization/git/_components/RepositoryInventory.tsx` renders `indexed` as
`Current` and defends it in a header comment: the label was promoted from `Indexed` once `stale`
existed, on the reasoning that _"`indexed` renders as `Current` because that is what it now MEANS."_
That reasoning holds only when both shas are known, which the null-head population never satisfies.
**MOTIR-4817** carries the fix and the reproduction; this asset is the design it fixes to.

### 4.2 The repository row COMPOSES the shipped one — it is not a second row

`RepositoryInventory` ships on **Settings → Organisation → Git**, built to
`design/github/github.mock.html` Panel 6, and it already renders a repository row with exactly this
anatomy: provider mark, `owner/name` with the owner in `--el-text-secondary` and the name in
`--el-text`, and the index pill. **This asset does not redraw it.** What it specifies is what
DIFFERS on a project surface:

| the org inventory row has             | the project row                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **`Used by N projects`**, expandable  | **absent** — on a project surface the answer is always "this one", so the control would be noise        |
| **`Disconnect`** / `Remove on GitHub` | **absent** — removal is an ORG act (§3); a project surface that offered it would cascade invisibly      |
| the index pill alone                  | the pill **plus the drift**: `312 behind` on the chip, and the panel-D block underneath when it matters |
| nothing about the graph's commit      | the **indexed sha**, mono, so a person can match it against what they pushed                            |

Two rules follow, and they are what stops this becoming a fork:

1. **The pill is the SAME pill**, with the same four tones — `Indexed` mint · `Stale` peach ·
   `Indexing…` sky · `Never indexed` neutral. A project surface and the org inventory disagreeing
   about one repository's state is exactly what the ONE derivation exists to prevent, and a second
   pill would reintroduce it at the presentation layer.
2. **The row keeps the hover tint**, and therefore the ink rule that comes with it:
   `--el-text-secondary`, never `--el-text-muted`, which fails AA on the hovered surface. The shipped
   component carries that correction inline; a copy that dropped it would fail
   `tests/design-state-ink-contrast.test.ts`.

---

## 5. The panels

| #     | state                                     | what it draws                                                                      |
| ----- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| **0** | **THE DOORS**                             | Both access paths, in situ, with the host dimmed.                                  |
| **A** | no repo, project **has** implemented work | The connect aside — shown, and its dismissed collapse.                             |
| **B** | no repo, **nothing** implemented          | Nothing is drawn. The deliberate quiet state.                                      |
| **C** | connected and current                     | The per-repo code-context list.                                                    |
| **D** | connected, **stale**, **not moving**      | The warning register. D1 = 312 commits, D2 = 1 commit, D3 = the no-action variant. |
| **E** | planning without code context             | The anti-silence state, on `/planning`.                                            |
| **F** | **current again**                         | The moment the warning resolves.                                                   |
| **G** | **indexing**                              | A refresh genuinely in flight — the only moving state.                             |
| **H** | **never indexed**                         | Connected, but no graph has ever been built.                                       |
| **V** | the four verdicts                         | `indexed · stale · indexing · never` — the SHIPPED names (§4.1), side by side.     |

---

## 6. What this asset does NOT cover, so no one draws it twice

| out of scope                                                                                                       | owner                                              | why it is not here                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The **consent gate** — the question a planning session asks before proceeding                                      | [MOTIR-4601]                                       | It is a conversational `ask_user` inside the session, rendered by the **shipped** `ask_user` presentation. A second, visual copy drawn here would be a design of a UI the product does not have. |
| The **auto-plan condition text** under the settings row                                                            | [MOTIR-4603]                                       | A copy line under a shipped settings row, not a new surface.                                                                                                                                     |
| **Any commercial cause** — a credit balance, an allowance, a quota                                                 | [MOTIR-4541]                                       | No panel shows one. The surfaces state the **consequence** and the **remedy**; _why_ indexing paused in cost terms lives in the platform-admin panel.                                            |
| **The tenancy move itself** — org-keyed graph, per-project visibility, dropping `ProjectRepo.githubRepoId @unique` | [MOTIR-2029]'s decision + its implementation story | This asset draws the surface that model produces and names, in §1, exactly which states are unreachable until it lands.                                                                          |
| **The rail's bottom section losing `Git`**                                                                         | a shell design-amendment card                      | `design/shell/rail-bottom-section.mock.html` is that section's design of record (§2).                                                                                                            |
| **Restoring a provider's ability to be indexed**                                                                   | [MOTIR-4609], under epic [MOTIR-4608]              | This asset only makes the resulting state speak truthfully.                                                                                                                                      |
| Granting, webhooks, the fetch/ingest path                                                                          | the shipped GitHub / GitLab integrations           | The Add-or-remove button hands off to them; this asset does not re-draw granting.                                                                                                                |

## 7. The ACCESS PATH — SUPERSEDED by §2

> **⚠️ This section drew TWO doors — the connect aside in situ on `/code-health`, and the
> code-context strip in the `/planning` rail. The collapse replaced both with ONE nav row, so the
> section is superseded rather than edited: §2 is the access path now.**
>
> **What survives it, and is why the deletion is not silent:** the rule it was written to satisfy —
> _a top-level view's access path lives in the SHELL / NAV, verified against the shell design and the
> nav convention, never an affordance drawn inside a feature's own mock_. The first revision honoured
> that rule by drawing the aside inside its host; §2 honours it by composing the rail itself. The
> `/planning` strip is not re-homed by this asset at all — panel E is what `/planning` keeps, and it
> now LINKS to the Code room rather than being a second copy of it.

## 8. The connect aside — INHERITED vs NEW

Source of the pattern: `design/coding-convention/design-notes.md` (its §10.3 block and Panel 6 state
gallery), built in `app/(authed)/code/_components/DeepenAuditCard.tsx`.

**Inherited wholesale — do not re-decide any of it:**

| element         | inherited value                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| container       | `--el-surface-soft` fill (**never** the report's white `--el-card`), `--el-border`, `--radius-card`, `--spacing-card-padding` |
| eyebrow         | "Optional · non-blocking", `--el-text-secondary`, 11 px, uppercase, letter-spaced                                             |
| dismiss         | ghost **×** (lucide `x`), `--el-text-muted`, top-right                                                                        |
| lead glyph      | lucide `scan-search`, `--el-accent-on-surface`                                                                                |
| title           | `--font-serif`, 16 px / 600, `--el-text-strong`                                                                               |
| sub             | 14 px, `--el-text-secondary`                                                                                                  |
| best-fit line   | 12 px / 500, `--el-text-secondary` — names the trigger                                                                        |
| dismissed state | collapses to a quiet one-line `--el-link` re-open row                                                                         |

**New here, and only this:**

1. **The subject.** The §10.3 aside connects a _scanner_; this one connects a _repository_.
2. **Two losses, not one.** The sub names **both**: plans are generated _without reading the
   codebase_, **and** _work items will not move themselves_ — pull-request → status sync rides the
   same connection. The second is often the more motivating half, so it is not a footnote.
3. **One action, not a tool choice.** The §10.3 aside offers two tool rows; this one offers a single
   **Connect a repository** primary button deep-linking to Settings → Workspace → GitHub / GitLab.
   There is nothing to choose between here — the provider choice belongs to the shipped grant flow.
4. **The trigger sentence.** The best-fit line reads _"N work items in this project have been
   reported implemented."_ — the honest state MOTIR-1767 settles.

### ⚠️ 8.1 Dismissal PERSISTS per project, per browser — CORRECTED 2026-09-05

**[MOTIR-1764]'s own body asserted, as a rung-2 finding, that dismissal is EPHEMERAL —
_"`DeepenAuditCard` holds it in `useState` and offers a re-open link"_. That reading is FALSE, and
the correction is recorded here rather than quietly designed around.**

The shipped precedent persists the flag in **`localStorage`, keyed per project**:

- `app/(authed)/code/_components/CodeHealthClient.tsx` defines
  `dismissKey(projectId) => 'motir:code-health:deepen-dismissed:' + projectId`, reads it through
  `useSyncExternalStore`, and writes `'1'` / removes it on dismiss and re-open.
- `DeepenAuditCard.tsx` holds `useState` only for `copied` and `expanded`. The **dismissal is the
  parent's**, which is why a read of the child alone concludes the opposite.
- `design/coding-convention/design-notes.md` Panel 6 State D already says so in words: _"the
  dismissal is per-project so it doesn't nag on every visit"_. The card's claim contradicted both the
  code and the note it cited as its pattern source.

**The half that WAS right stays right:** there is **no per-user dismissal store in the schema** —
`prisma/schema.prisma` carries `NotificationPreference` and `UserAppearancePreference`, neither of
which is a hint store. The conclusion drawn from that fact was the wrong one: the precedent does not
persist server-side, it persists **client-side**.

**So the drawn contract is:**

- Dismissing hides the aside for **that project in that browser, durably** — it survives a reload.
- A quiet one-line link re-opens it, and re-opening **clears** the stored flag.
- **No persisted "never show again" is drawn**, and no code card may invent a preference table for
  it. The behaviour is `localStorage` + `useSyncExternalStore`, a second use of a shipped pattern.
- `localStorage` is per browser. The same project on another device shows the aside again. That is
  the precedent's behaviour and the copy never over-promises otherwise.

This supersedes [MOTIR-1754]'s acceptance criterion _"Dismissal is session-scoped … nothing is
persisted"_, which was written from the same misreading. Both cards are amended on the record.

---

## 9. Drift is stated in COMMITS — and why an age is a _wrong_ verdict, not a weaker one

**State D leads with the drift: "312 commits behind".** No panel expresses the verdict as an age.

The reason is not tone. **Age and drift disagree about the answer:**

- A graph built three weeks ago on a repository nobody has pushed to is **current**. Motir is
  planning against exactly the code that is there.
- A graph built two hours ago on a repository that took 300 commits since is **badly stale**. Motir
  is planning against code that no longer exists.

An age-led verdict gets both of those backwards. So _"indexed 3 days ago"_ may appear as **secondary
detail beside the drift** — it never leads, and the verdict is never derived from it.

**The drift count is the code card's input, not the design's invention.** The surface needs a
`commitsBehind: number | null` beside the verdict:

- a **number** → _"N commits behind"_ in the headline, and _"N behind"_ on the chip;
- **`null`** → _"Behind by an unknown number of commits"_ in the headline, and **"Behind"** on the
  chip (panel D3). A chip reading **"Stale"** is the age framing in miniature and is not drawn.

**⚠️ This is an obligation this design places on [MOTIR-4644], and it has MOVED.** As first written
it named [MOTIR-1767]'s verdict function, which compared `indexedCommitSha` against a
`GithubRepo.lastPushSha` of its own. Both are gone: MOTIR-4724 shipped the ONE derivation, and
`deriveCodeGraphIndexState` distinguishes `stale` from `indexed` by a sha **inequality** — which
yields a boolean, not a count. So the obligation stands exactly as stated and simply has a new owner:

- **A count needs a source**, and the constraint is unchanged — **no provider round-trip may happen
  on a page render** (`GithubRepo.defaultBranchHeadSha` is written by the push webhook precisely so
  that nothing has to ask the provider at render time).
- `CodeContextRepoDTO.commitsBehind` already exists and is **always `null` today**, carried rather
  than dropped because `isBadlyStale` pauses the auto-cadence on a THRESHOLD, which
  `indexState === 'stale'` cannot stand in for.
- **[MOTIR-4644] is its producer.** That `null` is a legal answer this surface renders — panel D3 —
  is settled here.

---

## 10. Registers — where the inherited §10.3 grammar STOPS

Three rungs, and the split is the whole reason state D is not another aside:

| rung           | used by                                               | fill / edge                                                                                                                       | reading                                                                    |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **invitation** | panel A (connect aside), panel B (nothing)            | `--el-surface-soft`, `--el-border`                                                                                                | _optional; the thing you are reading is already complete_                  |
| **warning**    | panel D (stale, not moving), panel E (planning blind) | `--el-warning-surface` fill + a `--el-warning` **edge**, ink `--el-warning-text`, glyph lucide `triangle-alert` in `--el-warning` | _a fact that degrades the product's output; you should not skim past this_ |
| **error**      | —                                                     | not used                                                                                                                          | nothing in this story is an error                                          |

**Where the inherited register stops:** the §10.3 anatomy is an **invitation** — it exists to deepen
an already-complete report and must never gate it. State D is **not that**. It reports that plans are
being produced against code that is not the code, which is a defect in the output rather than an
optional improvement to it. Stretching one aside grammar over both would make the warning read as
optional, so the asset does not: D takes the token layer's own warning family, one rung up, and keeps
the aside grammar for A alone.

**Still not alarming.** No red, no destructive family, no modal, no blocking. The weight comes from
the peach warning surface plus a coloured **edge** — the one thing panel A does not have — and from
the copy naming a consequence in words.

**State D's colour is not invented.** It is the existing warning family in
`packages/design-system/theme.css`: `--el-warning-surface` (`--color-tint-peach`), `--el-warning`
(`--color-warning`) and `--el-warning-text` (`--color-charcoal`). Both flip with the theme, verified
in `code-context.dark.png`.

### 10.1 ⚠️ `stale` and `indexing` are TWO states, and only ONE of them is moving

The earlier direction — _stale "must read as catching up, not broken"_ — is **superseded, and the
"catching up" half is actively wrong.** A refresh can be paused, failing, or impossible for the
provider entirely. **A stale repository may sit stale for ever.**

**The copy rule, in words:**

- **Panel D (`stale`) promises nothing.** No _"catching up"_, no _"shortly"_, no _"check back"_, no
  _"this will resolve"_. It states the drift, states the consequence, says **"This index is not
  updating."**, and offers the action that exists — or, in D3, says plainly that none can be started.
- **Panel G (`indexing`) is the only panel allowed wait-and-return language.** It is the only state in
  which something is actually happening.
- **A run that cannot prove a refresh is in flight renders D, never G.** The default is the one that
  promises nothing.

They are separated at a glance by three things at once: **surface** (peach warning vs sky info),
**glyph** (static `triangle-alert` vs spinning `loader-circle`) and **copy**. Never by colour alone.

### 6.2 The action on state D

D1/D2 offer a secondary **"Rebuild now"** (lucide `refresh-cw`), composing the shipped
**"Re-audit now"** grammar from `DeepenAuditCard.tsx`. It **reuses the refresh enqueue [MOTIR-4604]
already fires at session start** — it is not a new mechanism, and [MOTIR-1768] wires it.

**D3 has no button at all.** Where nothing can be enqueued the honest rendering offers no action and
says so: _"No rebuild is offered, because none can be started."_ An action that cannot succeed is
worse than none.

---

## 11. Per-element token + primitive map, and who specifies each behaviour

The code card composes these; it does not choose new ones.

| element                                    | primitive                                                  | colour tokens                                                        | shape tokens                              | behaviour specified by                                                                |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| connect aside container                    | `components/ui/Card.tsx` grammar, **soft** variant         | `--el-surface-soft`, `--el-border`                                   | `--radius-card`, `--spacing-card-padding` | §10.3, `design/coding-convention/design-notes.md`                                     |
| aside eyebrow                              | `components/ui/SectionLabel.tsx`                           | `--el-text-secondary`                                                | —                                         | §10.3                                                                                 |
| aside lead glyph                           | lucide `scan-search`                                       | `--el-accent-on-surface`                                             | —                                         | §10.3                                                                                 |
| aside title                                | serif heading                                              | `--el-text-strong`                                                   | `--font-serif`                            | §10.3                                                                                 |
| dismiss ×                                  | ghost icon button                                          | `--el-text-muted`                                                    | `--radius-control`                        | §8.1 (this file)                                                                      |
| re-open link                               | text link                                                  | `--el-link`                                                          | —                                         | §8.1 (this file)                                                                      |
| **Connect a repository**                   | `components/ui/Button.tsx` `variant="primary" size="sm"`   | `--el-accent` / `--el-accent-text`                                   | `--radius-btn`, `--height-btn-sm`         | the shipped grant flow                                                                |
| **Rebuild now**                            | `components/ui/Button.tsx` `variant="secondary" size="sm"` | `--el-text`, `--el-button-border`                                    | `--radius-btn`, `--height-btn-sm`         | [MOTIR-4604] (the enqueue), [MOTIR-1768] (the wiring)                                 |
| repo row                                   | **composes `RepositoryInventory.tsx`** — see §4.2          | `--el-card`, `--el-border`, `--el-text-strong`                       | `--radius-card`                           | [MOTIR-1767] (`CodeContextRepoDTO`)                                                   |
| commit sha                                 | mono inline                                                | `--el-text-secondary`                                                | `--font-mono`                             | `GithubRepo.indexedHeadSha` ([MOTIR-4724])                                            |
| verdict `indexed` (chip reads **Indexed**) | `components/ui/Pill.tsx`                                   | `--el-success-surface` + `--el-text-strong`, glyph `circle-check`    | `--radius-badge`                          | `lib/codeGraph/indexState.ts` ([MOTIR-4724]); the LABEL by §4.1 + [MOTIR-4817]        |
| verdict `stale`                            | `components/ui/Pill.tsx`                                   | `--el-warning-surface` + `--el-warning-text`, glyph `triangle-alert` | `--radius-badge`                          | `lib/codeGraph/indexState.ts` ([MOTIR-4724])                                          |
| verdict `indexing`                         | `components/ui/Pill.tsx`                                   | `--el-notice-info-bg` + `--el-text-strong`, glyph `loader-circle`    | `--radius-badge`                          | `lib/codeGraph/indexState.ts` ([MOTIR-4724]) — the LEDGER resolves it, not the column |
| verdict `never`                            | `components/ui/Pill.tsx`                                   | `--el-muted` + `--el-text-secondary`, glyph `circle-dashed`          | `--radius-badge`                          | `lib/codeGraph/indexState.ts` ([MOTIR-4724]) — no succeeded run in the ledger         |
| stale warning block                        | callout                                                    | `--el-warning-surface`, `--el-warning` edge, `--el-warning-text`     | `--radius-card`                           | §5, §6 (this file)                                                                    |
| indexing block                             | callout                                                    | `--el-notice-info-bg`, `--el-info` glyph                             | `--radius-card`                           | [MOTIR-1767] (`indexState === 'indexing'`)                                            |
| settled line (F)                           | inline banner                                              | `--el-success-surface`, `--el-success` glyph                         | `--radius-card`                           | §8 (this file)                                                                        |
| planning-blind block (E)                   | callout                                                    | `--el-warning-surface`, `--el-warning` edge                          | `--radius-card`                           | `lib/ai/codeContext.ts` (`resolveCodeContext` returning `undefined`)                  |
| the head sha staleness is compared against | —                                                          | —                                                                    | —                                         | `GithubRepo.defaultBranchHeadSha`, written ONLY by `githubWebhookService.ts:340`      |

**Two shape rules the code card must not break.** State is never signalled with a hardcoded **dashed
or dotted border** — it clashes with `data-style`; use a token-driven tint plus a label and a glyph.
And no raw utility (`rounded-md`, `p-2`, `h-9`) or Tier-0 `--color-*` — element tokens and the
element-semantic shape tokens only.

---

## 12. State F — the warning must be seen to clear

Without F the honest warning this story adds never visibly resolves, which teaches people to ignore
it. A refresh lands while the surface is open:

- the warning block is **replaced in place** by a settled line — _"Code graph rebuilt — now current at
  `9c14e02`."_, `--el-success-surface`, lucide `check` in `--el-success`;
- the repo row underneath returns to its panel C reading;
- **quiet, once, and self-erasing** — it is gone on the next read.

**Not a toast queue** (it belongs in the slot the warning occupied, so nothing moves and nothing has
to be dismissed) and **not a persistent badge** (a badge that stays re-creates the nagging the §10.3
register exists to avoid).

---

## 13. State B — what a project with nothing shipped yet sees

**Nothing.** Both hosts render exactly what they render today.

The trigger for the aside is **implemented work**, not **absent repository**: a project that has not
shipped anything does not need to be asked for a repository that does not exist yet. Asking at
onboarding time would be wrong for the same reason. [MOTIR-1767] settles the predicate — any work
item with a non-null `implementationSource`, which is exactly _"someone reported implementing work"_
— and it is deliberately not _"any done item"_ (a migrated project is full of those) and not _"any
pull-request link"_ (that presumes the very connection the aside is asking for).

The dimmed outline in panel B marks the space the aside would occupy. It exists so a reader can see
the absence is a **decision**, and is not itself a drawn element.

---

## 14. Accessibility and theme

- Every state is carried by **tint family + glyph + copy**, never by colour alone (WCAG 1.4.1).
- Ink is `--el-text-strong` / `--el-warning-text` on tinted surfaces; the warning family's
  charcoal-on-peach pairing is the one `theme.css` already holds to its AA bar.
- Both themes are exported. `code-context.dark.png` is the same board with `data-theme="dark"` on the
  root; every ink flips because `color` is declared on the scoped containers rather than inherited
  from `body` alone.

---

## 15. How this asset was produced

The mock is **generated, not hand-typed**, so it cannot drift from the shipped layer:

1. **Tokens.** A throwaway script strips comments from `packages/design-system/theme.css`, then
   brace-counts three blocks out of the comment-stripped source: the Tier-0 `@theme` block (re-emitted
   as `:root`), the Tier-3 `:root, [data-appearance-scope]` block, and the `[data-theme='dark']` flip.
   Nested at-rule groups are dropped and each block's declarations are emitted **unlayered** into a
   leading `<style>`, with the Tier-3 block emitted a second time under a bare `[data-theme]`
   selector so a theme flip recomputes against its own Tier-0. 109 Tier-0 + 207 Tier-3 + 28 dark
   declarations. **No hex is retyped.**
2. **Icons.** Every `<symbol>` is the `__iconNode` array of the installed `lucide-react` icon file,
   following alias re-exports while keeping the requested id. The GitHub mark is taken verbatim from
   `components/icons/GithubMark.tsx`, because lucide ships no brand icons.
3. **Layout CSS** is hand-authored in the same semantic-class style as
   `design/coding-convention/design-notes.md`'s mock, and the button rules mirror
   `packages/design-system/src/components/ui/Button.tsx` variant for variant.
4. **Export.** `node scripts/render-design-mock.mjs design/code-context/code-context.mock.html --width 1200`
   (the width is passed explicitly — the script's viewport search keeps the first candidate matching
   on width and can lock in a half-width 2× render). The dark export is the same page with
   `data-theme="dark"` set on the root before a full-page screenshot.
5. **Verification** was by measurement, not by looking: a headless probe read back
   `--el-page-bg`, `--el-warning-surface`, `--el-warning`, `--el-surface-soft`,
   `--el-success-surface`, `--el-notice-info-bg`, `--radius-card`, `--spacing-card-padding` and
   `--shadow-card` as resolved values, confirmed every `<use href>` resolves to a defined symbol, and
   re-read the same properties with `data-theme="dark"` to confirm no ink collapses onto its own
   surface.

The generator scripts were deleted before the commit, so this section reproduces them rather than
citing a path that would not exist on `main`.

---

## 16. Amendments this design makes to sibling cards

Recorded here because a design that answers a card's open questions routinely changes that card, and
the change belongs on the record rather than in a build.

**From the first revision, unchanged:**

1. **[MOTIR-1764] (this card) and [MOTIR-1754] — dismissal persistence.** _"Session-scoped; nothing
   is persisted"_ is falsified by `CodeHealthClient.tsx`. See §8.1.
2. **[MOTIR-1767] — the drift count.** The verdict function needs to yield `commitsBehind`, with
   `null` a legal answer this surface renders. See §9.
3. **[MOTIR-1768] — the rebuild action.** Wiring **Rebuild now** to [MOTIR-4604]'s enqueue, and
   suppressing it where nothing can be started. See §10.2.

**Added by the 2026-09-05 rework, and these are larger:**

4. **[MOTIR-1768] is re-scoped and re-sized.** It was _"the code-context UI — connect affordance +
   freshness indicator on `/planning` and `/code-health`"_. It is now **one `Code` page with two
   sections — Repositories and Health — and a new primary nav row**, reading the PROJECT's connected
   set rather than the workspace's.

   ⚠️ **CORRECTED 2026-09-07 (MOTIR-4866).** This item said _three_ sections _"and the `Add or remove
repositories` action"_. Both were taken back by that card's own re-scope later the same day — the
   `Index` section (§4), the add/remove action and the member connect row (§3) — and this asset had
   absorbed only the first. The card was re-sized DOWN, 8 points to 5, in the same pass, which is the
   same rule running in the other direction: an estimate is a claim, and it is owed a correction when
   the claim changes.

5. **[MOTIR-1767] reads the PROJECT's set.** Its service currently resolves repositories from the
   workspace installation, which is the leak §1 names. Corrected on the record.
6. **[MOTIR-2029]'s decision is MADE, not proposed.** That record asked whether a repository should
   be indexed into every project of its workspace and left four options. Yue has answered: neither —
   **one graph per repository per organisation, with per-project visibility**, which was that
   record's option 4. The ADR is updated to record the decision and its consequences.
7. **A shell design amendment is owed** for `design/shell/rail-bottom-section.mock.html`, which is
   the design of record for the row this collapse removes. Named in §2; owned by its own card.
8. **The tenancy move is its own story** — org-keyed `CodeRepo`, per-project visibility, and dropping
   `ProjectRepo.githubRepoId @unique`, which currently makes _"connect a repo to a second project"_
   inexpressible. Named in §1 with the four-row audit; not this card's to build.

## 17. The OUTAGE state on a planning turn — "I can't read your code right now" (delta)

**Subtask [MOTIR-8137] · story [MOTIR-8136]. A DELTA, not an edit.** Drawn in
`design/code-context/planning-turn-code-unreadable.mock.html`, which amends §5's panel E and the
plan-change rail (`components/planning/PlanChangeRail.tsx`, `TURN_RENDERERS`) and edits neither
mock. [MOTIR-1764]'s states, the Code page and the audit's "not measured" face are unchanged.

### 17.1 What this is, and what it is not

[MOTIR-1764]'s **state E** is _missing_ context: no repository connected or indexed — a standing
condition of the project that the person can fix. This is the _outage_: the project's code **is**
connected and indexed, and Motir cannot read it right now. A transient condition of the platform
the person cannot fix. The two never appear together (panel 5 draws state E beside the outage faces
once, labelled): state E offers **Connect a repository**, the outage offers nothing beyond
**Try again** and carries **no link to the Code page**.

### 17.2 The two faces

Both compose shipped pieces and **add no component**: the assistant `Bubble`, the passive marker
line, the information notice `EarlierNotice` (`--el-notice-info-bg` on `--el-text-strong`,
`--radius-control`, `--spacing-control-x/y`, 12px) and the rail's own secondary small **Try
again** (`RefreshCw`, `onRetry`).

| #   | State                                                                                | What the turn shows                                                                                                                                                                                       | Register               |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | **Plan-writing turn, outage** (generate / draft, expand, replan, augment, plan edit) | The assistant bubble holds the notice below and **nothing else** — no plan card, no proposal tree, no "plan ready" bar. Under it the marker line, then **Try again**. The canvas keeps the previous plan. | information            |
| 2   | **Question turn, outage** (`ask_project`, `debug_bug`)                               | The answer renders as today, **with the notice as the bubble's first child, above the answer**. The citation foot ("Answered from N work items") is unchanged.                                            | information            |
| 3   | Outage ongoing, a second turn                                                        | Each turn carries **its own** state. **No sticky banner** (17.3).                                                                                                                                         | —                      |
| 4   | Recovery                                                                             | The next turn is an ordinary turn, no outage chrome. Earlier outage turns **keep their notice and marker** — never cleared retroactively.                                                                 | —                      |
| 5   | Contrast with state E                                                                | Drawn once, labelled.                                                                                                                                                                                     | warning vs information |
| 6   | In flight                                                                            | The shipped in-flight line, exactly as today. The outage face appears **only when the turn ends**; there is no intermediate "reading code…" warning.                                                      | —                      |
| 7   | Narrow rail, keyboard, screen reader                                                 | The text wraps inside the bubble, never truncates; Try again is in the tab order.                                                                                                                         | —                      |

**The register is the decision.** A plan-writing turn that meets the outage **did not fail; it
declined to write blind.** It therefore takes the information register, never the rose failure
treatment (`--el-tint-rose`, "That didn't go through") the rail draws for a turn that really broke,
which would tell the person something broke on their side. A question turn's answer is delivered,
so it is not the failure treatment either, and **no per-claim marking is drawn**: the guarantee is
that the answer states no unread code fact as verified (the motir-ai rule), and the notice covers
the rest.

### 17.3 The one decision this card records — no sticky banner

The notice lives **on the turn**. No banner is pinned to the rail head or the page while the outage
lasts. A banner would outlive the outage — still there, or needing dismissal, after the code is
readable again — and teach people to read past it (the argument §12 makes for the freshness warning
that must be seen to clear). The rail head and composer look exactly as they do on a healthy day. Two
turns in one outage say the same thing twice, on purpose: the statement belongs to the turn it is
true of.

### 17.4 The exact strings

The words are the contract; code and design agree on them. New keys sit beside
`planningWorkspace.conversation` in `messages/en.json`; **Try again is the shipped `retry` key**,
not a new string.

| Key                 | Text                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `outage.planBody`   | I can't read your code right now, so I haven't changed your plan. Motir is on it.             |
| `outage.planMarker` | Nothing was written — your plan is unchanged.                                                 |
| `outage.askNotice`  | I couldn't read your code for this answer. Treat anything about the code here as unconfirmed. |
| `retry` (shipped)   | Try again                                                                                     |

**No panel states a cause in infrastructure terms** (graph service, replica, machine), a credit or
cost reason, or any operator detail — and neither does a string.

### 17.5 Per-element tokens and behaviour

| Element     | Primitive / token                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The notice  | Information notice: `--el-notice-info-bg` fill, `--el-text-strong` ink, `--radius-control`, `--spacing-control-x/y`, 12px, a 14px `Info` glyph (`aria-hidden`). |
| The bubble  | The shipped assistant `Bubble`: `--el-chat-bubble-ai`, `--radius-card`, 13px. The notice is its first child with 8px below it.                                  |
| The marker  | The shipped passive marker: centred, 12px, `--el-text-secondary`.                                                                                               |
| Try again   | The shipped secondary small `Button` + `RefreshCw`; `onRetry` re-submits the **same** request; disabled while it runs. Plan-writing turn only.                  |
| Live region | The notice is `role="status"` — announced once when the turn is appended; a reloaded thread draws it without announcing.                                        |
| Ink         | `--el-text-strong` on the tint; captions `--el-text-secondary`. Never `--el-text-faint` or muted on a tint.                                                     |

### 17.6 The contract the render card reads ([MOTIR-8141])

The render draws from **(a) the turn kind** — plan-writing or question — and **(b) the presence of
the outage signal** on the turn's job result (the `codeUnreadable` field motir-ai sets: `halt:
'code_unreadable'` with the repository, the repository set and the reason), **and nothing else**.
It must **not** display the repository or the reason: they are the operator's. A plan-writing job
with the signal was halted and wrote no plan (face 1); a question job with the signal was answered
(face 2) — told apart by the job kind, not by a second field.

### 17.7 Entry path

No new entry. Both faces appear inside the turn the person is already reading in the planning rail
(`PlanChangeRail`, `TURN_RENDERERS.assistant`). Try again is the rail's existing re-submit.

### 17.8 What this does NOT decide

The component, the reading of the signal, and its tests ([MOTIR-8141]); what the signal is called
and how it is set (the motir-ai cards); the Code page, state E's panels and the audit face.

[MOTIR-8136]: https://app.motir.co/items/MOTIR-8136
[MOTIR-8137]: https://app.motir.co/items/MOTIR-8137
[MOTIR-8141]: https://app.motir.co/items/MOTIR-8141
[MOTIR-1754]: https://app.motir.co/items/MOTIR-1754
[MOTIR-1764]: https://app.motir.co/items/MOTIR-1764
[MOTIR-1765]: https://app.motir.co/items/MOTIR-1765
[MOTIR-1766]: https://app.motir.co/items/MOTIR-1766
[MOTIR-1767]: https://app.motir.co/items/MOTIR-1767
[MOTIR-1768]: https://app.motir.co/items/MOTIR-1768
[MOTIR-4541]: https://app.motir.co/items/MOTIR-4541
[MOTIR-4590]: https://app.motir.co/items/MOTIR-4590
[MOTIR-4601]: https://app.motir.co/items/MOTIR-4601
[MOTIR-4603]: https://app.motir.co/items/MOTIR-4603
[MOTIR-4644]: https://app.motir.co/items/MOTIR-4644
[MOTIR-4724]: https://app.motir.co/items/MOTIR-4724
[MOTIR-4817]: https://app.motir.co/items/MOTIR-4817
[MOTIR-4604]: https://app.motir.co/items/MOTIR-4604
[MOTIR-4608]: https://app.motir.co/items/MOTIR-4608
[MOTIR-4609]: https://app.motir.co/items/MOTIR-4609
