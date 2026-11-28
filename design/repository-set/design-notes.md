# `design/repository-set/` — design notes

**The area index. It now covers FOUR surfaces** — the three things a project's code has to answer:
where it comes to live, who on the team can get into it, and what the standing _"it's yours — move
it whenever you want"_ actually opens onto.

| Surface                                                                                                                            | Asset                                                                                                                               | Card                                                                                                                             | Sections    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **The establish step** at plan approval                                                                                            | [`repository-set.mock.html`](./repository-set.mock.html) + [`repository-set.png`](./repository-set.png)                             | MOTIR-1778 (design) → MOTIR-1782 / MOTIR-1900 (code) · **v5: MOTIR-5011 (design) → MOTIR-5014 / MOTIR-5015 / MOTIR-5016 (code)** | §0–§13      |
| **The take-it-over flow** — move a repository to your own GitHub                                                                   | [`takeover.mock.html`](./takeover.mock.html) + [`takeover.png`](./takeover.png)                                                     | MOTIR-1938 (design) → MOTIR-1939 (surface), MOTIR-711 (saga)                                                                     | §14         |
| **Team code access** — who else on the team can clone it                                                                           | [`team-access.mock.html`](./team-access.mock.html) + [`team-access.png`](./team-access.png)                                         | MOTIR-1944 (design) → MOTIR-1945 (surface), MOTIR-1910 (API)                                                                     | **§15**     |
| **The room's two registries** — hosted set + workspace-connected, and the room's own `Add repository` door                         | [`repositories-room.mock.html`](./repositories-room.mock.html) + [`repositories-room.png`](./repositories-room.png)                 | MOTIR-3126 (bug: design + surface), MOTIR-3086 (the ladder), **MOTIR-4674** (the door + the two removals)                        | **§16–§17** |
| **A repository's SCIP upload credential** — Motir-managed on a hosted repository; mint, show once, list, revoke on an imported one | [`repositories-room--scip-upload-credentials.mock.html`](./repositories-room--scip-upload-credentials.mock.html) (delta on §16–§17) | MOTIR-12338 (design) → MOTIR-12340 (surface), MOTIR-12345 (E2E)                                                                  | **§20**     |

**Story MOTIR-1775 · subtask MOTIR-1778 (design gate, Principle #13). Re-scoped to v5 by Story
MOTIR-5010 · subtask MOTIR-5011.** §0–§13 are the design reference for the step at plan approval
that gives an approved plan somewhere for its code to live — and then gives the user a way to reach
it. It is the layout source of truth for **MOTIR-1782** (the approval-step UI) and **MOTIR-1900**
(collaborator access), and the surface **MOTIR-1785**'s E2E + acceptance video walk.

> **⚠️ READ §0.1's v6 ROW FIRST.** As of 2026-09-10 this asset is **HOSTED-ONLY and SILENT**: the
> board draws panels **0 · 1 · 1b · 2 · 8 · 9** and nothing else. §5's access PROMPT and §6's
> technical path are superseded — their sections are KEPT, each opening with a box saying what left,
> where it went, and which of their rules are still live. **Panel numbers 3–7 are retired and not
> reused**, so every existing citation of them still resolves. A reader arriving from MOTIR-1782 or
> MOTIR-1900 looking for the connect prompt should start at §0.1.
>
> **⚠️ AND v7 ADDS THE THIRD `created` ARM — read §4 before building `AccessReport`.** The
> `created` state was drawn with TWO arms, _the account is known_ and _there is no identity_, and
> there is a third: the account IS known, the invitation went out, and **GitHub refused it**. The
> row stays `not_invited` (MOTIR-1900's graceful degradation, working as designed), so arm B's
> condition matches and its sentence — _"Motir doesn't know your GitHub account yet"_ — is false
> about the reader. §4 draws the refused arm and states all three conditions as predicates over the
> DTO.
>
> **⚠️ AND v6 ADDS THE POPULATION THIS STEP IS NOT FOR — read §7b before building anything that
> renders the step.** A project whose repository set arrived ALREADY SETTLED — every row
> `connected`, because the repositories are the organisation's and onboarding connected them — gets
> **no step at all**: the canvas has the whole pane. Until v6 this asset declared that population
> IMPOSSIBLE (§4's panel-2 table said `connected` _"cannot occur"_), while the shipped surface
> rendered the step for it on every approval. §7b draws the absence; §4's table row is corrected in
> place; §2 carries the code read that settles it.

- **Asset of record:** [`repository-set.mock.html`](./repository-set.mock.html) — the source of
  truth, built from the real design system. Its `.png` export
  ([`repository-set.png`](./repository-set.png)) is the board/PR-visible face.
- **Definition of done (three files, PER SURFACE):** `design-notes.md` +
  `<surface>.mock.html` + `<surface>.png`. All seven files are committed.
- **v5 render settings for `repository-set.png`:** `node scripts/render-design-mock.mjs
design/repository-set/repository-set.mock.html` — viewport **1200 × 900** at
  `deviceScaleFactor: 2`, exporting **2400 × 11496**. The exporter's baseline verdict was **EXACT**
  (its render of the asset at `HEAD` was byte-identical to the committed PNG), so the whole
  difference between the old export and this one is this revision's diff and none of it is
  environment drift. The committed height fell from **20176** to **11496** — five panels' worth.
- **v6 render settings for `repository-set.png`:** the same command and the same viewport
  **1200 × 900** at `deviceScaleFactor: 2`, exporting **2400 × 15274**. The exporter's baseline
  verdict was again **EXACT**, so the whole difference between the v5 export and this one is Panel 9
  and none of it is environment drift. The committed height rose from **11496** to **15274** — one
  panel's worth. This surface ships no `<name>.dark.png`, so one board is the complete set.
- **v7 render settings for `repository-set.png`:** the same command and the same viewport
  **1200 × 900** at `deviceScaleFactor: 2`, exporting **2400 × 16698**. The exporter's baseline
  verdict was again **EXACT** (`EXACT light 1200x900@2x committed=2400x15274 new=2400x16698`), so
  the whole difference between the v6 export and this one is §4's arm C and none of it is
  environment drift. The committed height rose from **15274** to **16698** — one `created` arm's
  worth.
- **Scope:** pixels and copy only. No React, no route, no `en.json` entries — those are
  MOTIR-1782's / MOTIR-1900's / MOTIR-1939's. **v6 adds no code and no strings either**: it
  SPECIFIES `titleMixed` / `promiseMixed` (§10) and the draw predicate (§7b), and MOTIR-5049 builds
  them.

---

## 0. The answer in one line

**When Motir is establishing code, it hosts it — for everyone; then it gets you access and tells you
it did. When there is nothing to establish, this surface is not there.**
One sentence and one button to say yes; the collaborator invitation goes out with the repositories;
and the state that follows **reports which account it went to**. Nothing on this surface asks the
user anything about repositories, because by the time they are standing here the product already
knows.

> **⚠️ v6 — the first clause used to read _"Motir hosts your code — for everyone"_, and the
> conditional in front of it is the whole of this revision.** _For everyone_ was answering the
> question **v2** got wrong — whether a founder is asked to curate a repository set — and about that
> question it is still right: no user, technical or not, is offered a choice here. It was never
> meant to answer _"does this surface appear for every project?"_, and it was read that way, because
> an unconditional sentence at the top of an asset is read as the asset's precondition. For a
> project whose code is its ORGANISATION's, _Motir hosts your code_ is simply false — and it was the
> sentence on screen. **§7b is the population the conditional names.**

**v5 removed two things and moved neither of them into a new corner of this step.** The access
PROMPT went, because the invitation is sent at establish. The technical path — "I already have
code", the rows, the roles, the derivation's "why", the full per-row state machine — went to
**onboarding**, which is the only place a project without a repository can be
(MOTIR-4753). What is left is one statement, one action, and one report.

---

## 0.1 · Revision history — this asset has been re-scoped THREE times, and all three are recorded

| Version                | What it drew                                                                                                                                | Why it changed                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1**                 | One question: "where should your code live?", one choice                                                                                    | The repo count is decided by the architecture, not by the user — a single choice cannot express a set                                                                       |
| **v2**                 | The derived set, as editable rows, as the default surface                                                                                   | Yue at design review: **too technical.** A founder cannot judge whether three repositories is right — `notes.html` #151, second time                                        |
| **v3**                 | "Motir will host your code" as the default; the rows behind "I already have code"                                                           | Right shape, wrong era — see below                                                                                                                                          |
| **v4 (this revision)** | Same default, plus the **access step**; the account-creation branch deleted; the main line re-inverted                                      | The ADR's ownership amendment (MOTIR-1893) + the access gap it opened (MOTIR-1900) + drawing a post-Epic-9 audience as today's user                                         |
| **v5**                 | HOSTED-ONLY and SILENT — panels 0, 1, 1b, 2 and 8; §5 and §6 superseded; `created` REPORTS                                                  | MOTIR-4753 gave the repository question to ONBOARDING in September; nothing swept this asset — MOTIR-5011                                                                   |
| **v6**                 | **Panel 9 — a SETTLED set draws NO step**; panel 1 gains the MIXED-set arm; panel 2's `connected` _"cannot occur"_ row corrected            | v5 removed the step's ability to PRODUCE a `connected` row and read that as the step never being SHOWN one — MOTIR-5050                                                     |
| **v7 (current)**       | **§4's `created` gains a THIRD arm** — the account is known and GitHub REFUSED. Arm B's condition is re-stated as a predicate, not as prose | Arm B was written for _"no identity"_ and guarded on `!login \|\| !anyInvited`, so a refusal fell into it and told the reader something false about themselves — MOTIR-5038 |

**⚠️ v4's row still says "(this revision)", and it is left standing rather than corrected.** The
rows are the record of what each revision decided, and editing an earlier one to keep a label
accurate is how a revision history stops being evidence. Read the LAST row as the current revision;
v6 is it. (v5's row lost only its `(current)` marker, for the same reason: the marker is not part of
what that revision decided.)

### What v7 changed, and why (MOTIR-5038, 2026-09-11)

**`created` was drawn with two arms and the product has three states.** v5 wrote the arms as _the
account is known_ (A) and _there is no identity_ (B), and both are right about the situations they
were drawn for — nobody made a mistake writing arm B. The third situation is: **Motir HAS the
account, sent the invitation at establish, and GitHub refused it** (`HTTP 403: Must have admin rights
to Repository.`). Nothing is stamped on a refusal, so the row stays `not_invited` — which is
MOTIR-1900's graceful degradation working exactly as specified — and arm B's guard,
`!login || !anyInvited`, is satisfied by its second disjunct. The panel then tells the reader
_"Motir doesn't know your GitHub account yet"_, which is a fact about THEM, and it is untrue.

**The state is not a defect to design away, and that was checked rather than assumed.** The question
to ask before drawing a state the product produces is whether the MODEL allows it: a state the model
forbids is a defect to fix, and drawing it ratifies it. Here the model allows it deliberately — ADR
§4.2's _"a side effect after commit, degrading gracefully"_ is the rule that PRODUCES it, §5 records
it as LIVE and load-bearing, and MOTIR-5016 built a notification for it. So the state is supported
and the COPY is the defect.

**The fix is a condition, not a sentence.** Arm B's condition was written in prose (_"no identity"_)
while its guard was a two-disjunct shape test, and the drift between those is the whole bug. v7
states all three arms as predicates over `ProjectRepoEstablishViewDto`, so the next reader checks the
drawing against the DTO instead of against a paraphrase.

**The sibling surface already asks the right question, which is why no new instrument is needed.**
`/settings/project/code-access` renders the same fact and branches on the DTO's own
`reason === 'no_github_identity'` — `notInvitedSelf` when there is no account, `notInvitedReady`
(**"@{login} is ready to be invited"**) plus an **Invite** control when there is one. Two surfaces,
one fact; one of them asks _is there an identity?_ and the other asks _did anything get sent?_. v7
brings this surface onto the first question.

**⚠️ THE SEVERITY RULING IS UNTOUCHED, AND ARM C IS DRAWN INSIDE IT.** An invitation failure never
fails a row; the repositories are real, the plan is safe, and the main line still says _"Your code is
ready"_ with the ownership promise under it. Arm C changes one sentence and nothing else: **no red
tint, no `failed` panel, no GitHub status code, no repository name, and the same door.** What it must
not become is a second failure state four inches from a success line.

**⚠️ TWO AMENDMENTS TO MOTIR-5038's OWN TEXT, ON THE RECORD.**

1. **The card cites the _"only user-visible consequence"_ sentence as §7's; it is not.** It lives in
   §0.1's _v5 supersedes PART of MOTIR-1900_ block and again in §5's supersession table. Both are
   amended above, and §7 is re-read and needs no change — its subject is whether the REPORT survives
   Epic 9, and the answer is unaffected by which arm the report shows.
2. **The card's predicate says _"every row `not_invited`"_; v7 narrows it to every INVITABLE row.**
   v6 landed the MIXED set (§7b) five hours after this card was authored, so the card could not have
   said it: a `connected` row is the organisation's, `needsCollaboratorInvite` is `state ===
'created'` only, and such a row is `not_invited` for ever by construction. Quantifying over every
   row would make arm C's condition turn on rows nothing will ever invite to. The narrowing is
   strictly safer and changes no case the card described.

### Why v5 left this gap — the distinction it turned on (kept, because the next reviser will face it)

v5 was ten hours old when this was found, and it was not careless: it re-read the composed components
file by file, diffed the token block key by key, and corrected a stale _"the diff is empty"_ line.
The gap is one inference, and it is a good inference that does not hold.

**v5 removed the step's ability to PRODUCE a `connected` row.** The technical path — _"I already have
code"_, the rows, the per-row picker — left for onboarding (MOTIR-5014), and `connected` was the
state that path wrote. So _"nothing is adopted here"_ became true, and panel 2's table recorded it as
`connected` **cannot occur**.

**What does not follow is that the step is never SHOWN a `connected` row.** The step does not own the
set; it RENDERS one. Rows reach `connected` through doors this step has never been part of —
onboarding's own connect step, and the Repositories room's `Add repository`
(`lib/services/organizationRepoService.ts`, which writes `state: 'connected'` +
`seedSource: 'organization'`). **Removing a WRITER of a state does not remove that state from the
READ.**

**The tell is grammatical, and worth carrying:** _"cannot occur"_ in a state table is a claim about
the whole system, but it is almost always written while reasoning about one component's own
transitions. When a revision removes a path, the honest entry is _"this surface no longer produces
it"_ — which leaves the reader asking what happens when it arrives anyway, instead of answering that
question for them by omission.

### Why v2 was wrong (kept, because it is the load-bearing product rule)

v2 drew the underlying model on screen — a row per repository with a role chip, an editable
`<owner>/<name>`, a seed source, and per-row GitHub failure reasons — and asked the user to curate
it. **That is a developer tool.** Motir is chat-first and explicitly not developers-only; the person
approving a plan is usually a founder who does not know what a repository is, let alone why their
project needs two.

This is the **`notes.html` #151 class, second occurrence**. #151 was the coding convention planned
as `proposed → edit → APPROVE → standard`, and the rule it produced is: _do not plan a human
approval gate — or a bespoke edit surface — for an AI-derived artifact a non-technical user cannot
meaningfully evaluate; derive it, use it automatically, and expose it read-only._ The repo SET is
exactly such an artifact: it is **derived** (ADR §0.1, from the plan's own contents), and a founder
cannot judge whether three repositories is right. **That rule still governs every default-path
screen here.**

### What v4 changed, and why (Yue, 2026-07-30, second review)

**1 · The account-creation branch is DELETED.** The per-row `Segmented` offered **Create for me**
(in the user's own account) vs **Use one of mine**. The ADR's
[2026-07-30 amendment](../../docs/decisions/project-repository-set.md#amendment-2026-07-30-yue--motir-1893)
removed the first: **Motir never creates a repository in the user's own account**, for anyone, so
"create" no longer names a second destination — it means the same Motir-hosted thing the default
path does. A two-way control with one option left is a lie about the choice on offer, so the row now
has a **default** (Motir creates it) and a **single quiet secondary**, **Use one of mine**, which is
an action, not an alternative. `useOneOfMine` survives unchanged because connect-existing is the only
path that ever touches the user's account — it is how a monorepo collapses the set to one row and how
a pre-provisioned repository in a governed org is used.

`ownTitle` / `ownLead` are re-worded for the same reason. They read as an alternative **home** for
new code ("Use your own GitHub instead"); they are now only an alternative **source**
("Use the code you already have").

**2 · The ACCESS step is drawn — new UI this asset had never depicted.** Repositories are created
under Motir's org and are **private**, so the user cannot clone their own code until Motir invites
them as an admin collaborator (**MOTIR-1900**), which needs a GitHub login Motir only has once they
connect. Drawn: the **connect prompt** (panel 3), the **per-row invitation states** (panel 4), and
the **ownership promise on the main line** rather than in a footnote — MOTIR-1785 asserts a reviewer
can SEE it in the acceptance video, so it is a line of its own with the door to MOTIR-711's transfer
beside it.

**3 · The main line is RE-INVERTED.** v3's notes concluded _"Motir-hosted is the default, so the
non-technical journey has no GitHub in it at all"_ and drew that GitHub-free path as the main line.
That end state is right, but **it arrives with the hosted agent**. Before Epic 9 there is no
non-technical workflow at all — the hosted agent is what would build the site a non-technical founder
validates — so until it ships, every user is technical, connects GitHub, and runs their own agent
locally. **The flow that exists today is the main line** (panels 0–4); the GitHub-free path is drawn
as the state it becomes once hosted execution lands (panel 8). Drawing an audience the product cannot
yet serve as the primary case was the v3 mistake, and panel 8 exists so the correction is a recorded
consequence rather than a redesign waiting to happen.

**No GitHub-permission or grant state is drawn anywhere**, deliberately. There is no "your grant is
not upgraded", no re-consent prompt, no org-owner warning: nothing in this flow asks the user for a
permission. The ADR's credential table is what makes that true — the user-facing App is **unchanged**
by this decision (`Administration` is _not_ added to it), the provisioning credential is Motir's own
on Motir's org and never appears in a user flow, and the only new consent the product ever asks for
is Epic 9's opt-in writer App, which is not this surface's business.

### Two of MOTIR-1778's own acceptance criteria are knowingly superseded — flagged, not quietly dropped

Both were written for v3 and are contradicted by the re-scope that produced v4, so they are answered
against the newer instruction rather than the older list. Neither is an omission:

- **"The Motir-hosted main line is drawn … and no GitHub prompt on it."** v4's re-scope says the
  opposite in as many words: _"the pre-Epic-9 main line **always continues into the connect + access
  step**."_ The main line therefore ends in **Connect GitHub** (panel 2 `created` → panel 3). The
  spirit of the original AC survives exactly where it was aimed — **nothing before or during setup
  mentions GitHub**, and no GitHub state gates approval. Panel 8 draws the state in which the
  original wording becomes true again.
- **"The default path is ONE sentence + one action + one small 'I already have code'."** The same
  re-scope requires the ownership promise **on the main line rather than as a footnote**, so panel 1
  carries a fourth element. It is a **statement, not a control** — one line of standing guarantee
  plus one link out — so the count of things the user must decide is unchanged, which is what the
  AC was protecting.

### What did NOT change

The **model** is untouched. The set still holds as many rows as the architecture decides, still
carries roles and per-row state, `targetRepo` still resolves through it (ADR §5), and the row
lifecycle is still §4.1's. Panels 1, 1b, 2, 6 and 7 are v3's, edited — not redrawn.

### What v5 changed, and why (MOTIR-5011 · Story MOTIR-5010, 2026-09-10)

**The one-line reason: this asset was authored in July against a product in which THIS was the first
place anyone was asked about repositories. It stopped being that in September, and nothing swept
it.** MOTIR-4753 shipped the **routing verdict**: before any planning
begins, a session reads the project and decides `continue` / `onboard_new_project` /
`onboard_existing_project` / `wait_for_index`, and `parseRoutingVerdict` refuses `continue` outright
when `!baseline.hasRepository` (`motir-ai` `src/llm/onboardingRouting.ts:210`). _You may find a
repository insufficient; you may not find its absence sufficient._ So **only onboarding plans
without a repository — that is what onboarding IS** — and connecting a repository the user already
owns is onboarding's `connect` step, drawn in [`design/onboarding-migrate/`](../onboarding-migrate/design-notes.md)
Panel 1. Everything this asset drew about that question became a **second answer to a settled
question**, which is how a product starts contradicting itself: one surface telling a person their
code is ready while another offers to connect the account it just used.

**Three changes, and each is recorded by SECTION number below rather than performed silently.**

**1 · §4's `created` state STOPS ASKING — it REPORTS, in two arms.** Its forward action was
`repositorySet.connectGithub` (into panel 3). The collaborator invitation
MOTIR-1900 already specifies as _"a side effect after commit, degrading
gracefully"_ is now **SENT at establish**, so the state says what happened rather than asking for
what it needs:

- **Arm A — identity known.** The ownership promise, _"Your code is ready"_, and the shipped
  `IdentityHeader` with an **invited** caption naming the account. Primary **Go to my backlog**,
  quiet **Open the invitation**. It keeps **Use a different account**, and that is not a residue of
  the ask: a mechanism that shows you which account was granted admin on your private code and
  offers no way to correct it is worse than one that asks. **What left is the ASK for the identity,
  never the ability to fix it.**
- **Arm B — no connected identity.** One quiet line — the shipped `notInvitedDetail`, _"Motir
  doesn't know your GitHub account yet"_ — with the door to `/settings/project/code-access`, whose
  label **reuses `repositorySet.outcomeNeedsAccess`** rather than restating its string. That is what
  makes "agrees with the rail word for word" a property of the code instead of a promise in these
  notes: `PlanDetail.codeOutcomeOf` already resolves this exact state as `needs_access` and
  `PlanReviewRail` already renders it as **"Finish setting up access"**.

**2 · §5's access step (panels 3–4) is SUPERSEDED as a PROMPT, and survives as ROW STATE.**

| What §5 held                                                                                           | Where it goes                                                                                                                    | Why                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel 3 — the connect prompt** (`accessTitle` / `accessLead` / `accessWhichAccount` / `accessLater`) | **Deleted.** Onboarding's `connect` step is where the identity is obtained                                                       | Motir already has the account by the time a plan can be approved; asking again is the defect                                                                                                                              |
| **Panel 3b — the `IdentityHeader`**                                                                    | **Kept, moved into §4's `created` arm A**                                                                                        | It was never the ask — it is the REPORT, and the report is the thing v5 is adding                                                                                                                                         |
| **Panel 4 — the per-row invitation states** (`invited` · `accepted` · `not invited`)                   | **`/settings/project/code-access`**, which already draws all three per person and per repository (`settings.codeAccess.state.*`) | Nothing about the states changes; what goes is a second surface drawing them. Verified against the shipped key set, not assumed                                                                                           |
| **`notInvitedDetail`**                                                                                 | **Kept, on §4's `created` arm B**                                                                                                | The one row-state string this surface still needs, because arm B IS that state at set level. **v7: it is no longer the ONLY one** — `not_invited` at set level has two causes, and `notInvitedRefusedDetail` is the other |

**3 · §6's technical path (panels 5–7) LEAVES for `design/onboarding-migrate/`.** Its subject —
connecting a repository the user already owns — is onboarding's. **v5 records the move and removes
the panels; it does not redraw them there**, and it deliberately does not amend
`design/onboarding-migrate/` at all: that asset already draws the `connect` step, and a design card
that edits two areas' assets is two cards.

**4 · §7's panel 8 is RE-READ, and v5 draws 8b.** Its two arms turned on _whether the access step is
primary_; v5 deletes the step from both, so that axis separates nothing. The surviving question is
smaller — **whether the REPORT is worth showing at all** once the hosted agent pushes for the user —
and the answer is **yes, it stays**: the invitation is sent whether or not the user ever clones
anything, and the ownership promise directly above it is a promise they cannot act on without
knowing which account holds the keys. **8a is no longer drawn.** Its home is this table and the row
above, not an artboard: a mock is the layout source of truth, and a board that still draws a retired
control is a specification for putting it back.

### The panel NUMBERS 3–7 are retired, not reused

The board runs 0 · 1 · 1b · 2 · 8. **The gap is deliberate and is the cheapest part of this
revision**: every citation of "panel 4" or "panel 6" in MOTIR-1782, MOTIR-1785, MOTIR-1900 and this
file's own §11–§13 keeps resolving to the thing that left, rather than to something new wearing its
number. Renumbering would have silently redirected all of them.

### v5 supersedes PART of MOTIR-1900's acceptance criteria — the connect prompt, and only that

MOTIR-1900 is `done` and shipped; this is not a re-opening of it, and the
same _flagged, not quietly dropped_ form v4 used for MOTIR-1778 applies.

**Superseded:** its **connect prompt** — the requirement that the user be asked to connect GitHub
from this step before the invitation can be sent. v5 sends the invitation at establish and reports
it, so the prompt has no trigger left on this surface.

**Untouched, and still the specification:**

- **The invitation mechanism itself** — invite the approving user as an admin collaborator on each
  repository Motir creates, resolved from `GithubIdentity.githubLogin` and **never from a typed
  handle**. v5 depends on this rather than changing it.
- **The three per-row invitation states** (`invited` · `accepted` · `not invited`) and their copy.
  They move surface (above); they do not change.
- **The re-send**, and **the graceful degradation** — _"a side effect after commit"_: an invitation
  failure never fails the row, because creation already succeeded. v5 leans on this harder than v4
  did, since establish now carries the invite, and it is what makes MOTIR-5016's refusal
  notification the only ADDED user-visible consequence of a refusal. **⚠️ v7 AMENDS THIS — it read
  "the only user-visible consequence", which is false and is the sentence that made the gap
  invisible.** A refusal has ALWAYS had a second consequence on this very surface: the row stays
  `not_invited`, which is a state §4's `created` panel renders. The sentence was true about what
  MOTIR-5016 ADDS and was read as a claim that the panel says nothing — when what the panel actually
  did was say the wrong thing. See §4's arm C.
- **Which account gets access** — connected, never typed, and therefore SHOWN (§5's own subsection,
  which is why the `IdentityHeader` survives the panel it was drawn in).

---

## 1. Where every decision came from (no flow is invented here)

| Behaviour                                                                                       | Source                                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The set's cardinality is DERIVED from the plan; the default is one `web` repo on thin signals   | ADR `docs/decisions/project-repository-set.md` §0.1 (MOTIR-1776, accepted)         |
| Presentation of a one-row set is this card's to decide, not the model's                         | ADR §6                                                                             |
| The role enum (`web` · `api` · `mobile` · `shared` · `infra` · `other`)                         | ADR §1.1                                                                           |
| ORDER is meaningful; the first row is the project's **primary** repository                      | ADR §1.3                                                                           |
| Names: `<project-slug>` at one row, `<project-slug>-<role>` at two or more; always editable     | ADR §1.4                                                                           |
| Collisions offer a suffixed name, pre-filled and editable, before the row is created            | ADR §1.5                                                                           |
| Seed source per role — the starter for `web`, an INITIALISED repo for everything else           | ADR §2                                                                             |
| **Every CREATED repo is Motir-owned and claimable — no account branch, for anyone**             | ADR §3 **amendment 2026-07-30** (MOTIR-1893)                                       |
| Connect-existing is untouched and is the only path that reaches the user's own account          | ADR §3 amendment                                                                   |
| The ownership promise the Motir-org default obliges the copy to make                            | ADR §3 amendment, closing paragraph                                                |
| A repo Motir owns is still the user's to REACH — collaborator invite, per created repo          | ADR §3 amendment · **MOTIR-1900**                                                  |
| The connect prompt belongs AFTER approval, framed as "get access to your code", never as a gate | **MOTIR-1900** ("not a gate before approval … but a prompt after it")              |
| Invitation states: invited / accepted / not-invited-no-identity, with re-send                   | **MOTIR-1900** acceptance criteria                                                 |
| An invite failure must NOT fail repo creation                                                   | **MOTIR-1900** ("a side effect after commit, degrading gracefully")                |
| The per-row state machine, row independence, no rollback, resumability, partial completion      | ADR §4.1–§4.4                                                                      |
| **Per-row async with polling — a `201` is not a ready repository**                              | **MOTIR-1777** spike, `docs/github-repo-creation-mechanics.md` §4.2 + finding 5    |
| 2–5 repos is nowhere near any rate limit; serialise anyway                                      | MOTIR-1777 spike §4.1                                                              |
| The single-repo project is the degenerate case of one model, never a second code path           | ADR §6                                                                             |
| The per-row **reason** a proposed row surfaces                                                  | MOTIR-1881 — "a row with no nameable reason should not exist"                      |
| The host surface, the split, the rail, the approve CTA, the decided outcome                     | `app/(authed)/plans/[id]/page.tsx` · `PlanningWorkspace` · `PlanReviewRail`        |
| The GitHub connect/install hand-off, and its two separable grants                               | `app/(authed)/settings/workspace/github/page.tsx` (7.10) — pointed at, not redrawn |
| The transfer this design promises but does not draw                                             | MOTIR-711 (9.3.7)                                                                  |
| Don't gate an AI-derived artifact a non-technical user can't judge                              | `notes.html` #151                                                                  |
| Design against what is SHIPPED — render it, don't read-and-redraw it                            | `notes.html` #73                                                                   |

### The spike has since LANDED — and it answers the question this design asked

v3 was drawn while MOTIR-1777 was still in progress. It is now `done` and
`docs/github-repo-creation-mechanics.md` is on `main`. Three of its findings bear on this asset, and
all three confirm the shape already drawn rather than change it:

- **Latency is still the one UNVERIFIED number** (§4.2 — the available credential had no
  `delete_repo` scope, so it is recorded as unverified rather than estimated). The design is safe
  either way, deliberately: the **default path** shows ONE status line for the whole set
  (_"Setting up your code…"_), which is right at 400 ms or 20 s and never exposes a per-repository
  count the user did not ask for; the **technical path** shows **per-row** progress, required if
  creation is slow and harmless if it is fast.
- **A `201` does not mean the repository is ready** (§4.2). Template seeding is not synchronous, so
  a row is `created` only after a readiness read succeeds. Panel 7's `creating` row says so
  (_"Seeding it from the starter"_) and the notes say it here, because it is the one spike answer
  that changes a UI card: **MOTIR-1782 must model each row as its own async job**
  (`pending → creating → seeding → ready | failed`), never one synchronous "create the set" request
  that returns when the last call returns.
- **Rate limits do not constrain this story's N** (§4.1: 80 content-generating requests/minute), so
  nothing here needs a batching or throttling affordance.

---

## 2. Drawn against SHIPPED reality — what was RENDERED first

The step lands inside a surface that already exists, so it was **rendered before anything was
drawn** (`notes.html` #73 — reading the `.tsx` is not seeing what renders). `pnpm build` +
`next start` on `origin/main` @ `c76e2b7a`, signed in against a tenant seeded through the shipped
services (`tests/e2e/_helpers/plans-review-seed.ts`), full-page screenshots at 1440×,
`deviceScaleFactor: 2`:

- **`/plans/<planned-plan>`** — the pre-approve state: the bordered `--el-canvas` box, the
  proposed-plan canvas, and the rail's **"Approve — add 1 item to your backlog"** / **Decline**
  gate with the hint _"Approve materializes the proposals into your backlog."_
- **`/plans/<approved-plan>`** — the state the step lands back into: the rail's pill flipped to
  **Approved**, the history gaining **"Approved · Plans Owner"**, and `DecidedOutcome` showing a
  `--el-success` Sparkles + **"Added 1 item to your backlog"** + **"View in backlog"**.
- **`/settings/workspace/github`** (nav label **"Git"**) — the two-grant connect flow. Panel 5b
  mirrors it as the hand-off target and redraws none of it.

**Re-verified for v4:** `git diff c76e2b7a origin/main` over `app/(authed)/plans`,
`components/planning`, `app/globals.css`, `packages/design-system/theme.css` and
`app/(authed)/settings/workspace/github` was **empty** — none of the composed shipped surfaces had
moved since those renders, so they still described reality and were not re-shot.

**⚠️ Re-verified for v5 (2026-09-10), and the same command now returns a LARGE diff — so it was
checked file by file rather than quoted as a verdict.** Six weeks of planning-surface work landed in
between (`ProjectRoadmapCanvas`, `PlanningWorkspaceOverlay`, `ProposalPeek`, and a 2,908-line
`theme.css` revision), and a stale "the diff is empty" line is exactly the sentence that makes a
drifted asset read as verified. What this asset actually composes was re-read on `origin/main`
`a55348224`:

- **`components/planning/PlanReviewRail.tsx`** — mirrored element for element, and the mirror still
  holds: serif title + `STATUS_TINT.approved` pill, the `itemCount` line, the history `<ol>`, and
  `DecidedOutcome`. **It has GAINED the one thing v5 depends on**: the `PlanCodeOutcome` line
  (`data-testid="plan-code-outcome"`), whose `needs_access` arm renders `AlertTriangle` in
  `--el-warning` + `repositorySet.outcomeNeedsAccess`. That is the shipped element §4's arm B now
  agrees with, and it is agreed with by reusing its key.
- **`components/planning/PlanDetail.tsx`** — `codeOutcomeOf` already computes exactly arm B's
  condition: a `created` row whose `access.state` is `not_invited` resolves to `needs_access`. **v5
  draws a state the product already computes**; it does not invent one.
- **`packages/design-system/theme.css`** — the mock's `:root` block was re-generated against it and
  diffed key by key: **301 tokens, one real drift** (`--el-status-done`, now a `color-mix`), which
  this revision refreshes. No other value moved, so the asset's palette is current rather than
  assumed to be.
- **`app/(authed)/settings/project/code-access/`** — NEW since v4, and it is what makes §5's
  hand-off real rather than aspirational: `settings.codeAccess.state.*` draws `invited` /
  `accepted` / `notInvited` per person and per repository, including `notInvitedSelf`, which is
  word-for-word `repositorySet.notInvitedDetail`.

**No new render was shot for v5, and that is a decision rather than a skip.** The step is the only
surface this asset draws that is not mirrored from shipped markup, and v5 REMOVES from it — the
frames that stay (panels 1, 1b, 2) are v4's, unchanged except for the CTA row. Where v5 adds, it
adds the `IdentityHeader` that panel 3b already mirrored from
`gitSettingsPrimitives.tsx`, and a warning line whose ink and icon are the rail's own.

The route header, the box, the `grid-cols-[1fr_22rem]` split and every element of the rail are
**mirrored markup**, not stylized stand-ins. **The step is the only new surface.**

### ⚠️ v6 · WHAT THE STEP RENDERS FOR A SETTLED SET — read off `origin/main` `000b2f56b`

v6 draws an ABSENCE, which cannot be rendered from shipped code: the whole finding is that the
surface appears where it should not. So what was established is **what the shipped step does for the
settled population today**, element by element, from the components that decide it. Four elements
render, and **three of them state something false about a repository the organisation owns**:

| Element                                                                            | Gate in shipped code                                                   | For an all-`connected` set                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `SectionLabel` **"Your project's code"** + `<h2>` **"Motir will host your code"**  | **NONE — rendered unconditionally**, outside every `state` branch      | **FALSE.** Motir hosts nothing here                                                              |
| ✅ **"Your code is ready"**                                                        | `state === 'ready'`                                                    | TRUE, and the only true line of the four                                                         |
| 🔒 **"It's yours. Motir keeps it safe and private — move it to your own GitHub…"** | `state === 'idle' \|\| state === 'ready'`                              | **FALSE, and absurd** — it already IS in their own GitHub                                        |
| ⚠️ **"Motir doesn't know your GitHub account yet"** + **Finish setting up access** | `state === 'ready'`, `AccessReport` arm B on `!login \|\| !anyInvited` | **FALSE** — a nag about access to a repository they own, four inches from _"your code is ready"_ |

**Why `state` is `ready` for this population, and why arm B fires with it — the two facts that make
the table hold together.** `defaultStateOf` returns `ready` when `rows.every(isSettled)`, and
`isSettled` counts `connected`; so a set that ARRIVED settled is indistinguishable, to the step, from
one it just finished establishing. Arm B then fires because `anyInvited` is false, and that is not an
accident of a fixture — it is **guaranteed by the write path**: `needsCollaboratorInvite` is
`state === 'created'` ONLY, so a `connected` row is never invited to, has no `admin` collaborator
record, and `deriveAccessState(null)` returns `not_invited`. The product's own comment says why
inviting would be wrong: _"a `connected` row is a repository the user ALREADY owns and granted Motir;
inviting anyone to it is at best a no-op and at worst Motir handing out access to a repository that
was never its to share."_ **So the two lines do not merely co-occur — each is correct about its own
question, and the pair is what is false.**

**⚠️ THE CO-OCCURRENCE WAS SETTLED FROM THE WRITE PATH, NOT FROM AN ASSEMBLED FIXTURE — deliberately.**
The claim above is that four elements render TOGETHER for one population, which is exactly the claim a
hand-built fixture gets wrong: its fields are each individually settable, and a fixture can compose a
state the product cannot be in. Reading the writer that sets `access.state` is the stronger
instrument here, and it is what the table rests on.

**No new render was shot for v6 either, and the reason is different from v5's.** A faithful render
needs a seeded tenant holding an organisation-connected repository AND an approved plan — the
`pnpm build` + `next start` + seed route of §2's original renders — and what it would show is the
table above, which the gates settle without it. What a render CANNOT show is the thing v6 decides,
because no shipped code path produces it. **The cheap disagreement is available to a reviewer:** every
row names its gate, so one `grep` per row checks it.

**⚠️ AND THE ROW COUNT IS THE OTHER HALF, AND IT IS NOT IN THIS COMPONENT.** The step never asks
whether it should be on screen — `app/(authed)/plans/[id]/page.tsx` decides, and its condition is
`repoView && projectKey && repoView.set.rows.length > 0`: a row COUNT, reading neither `state` nor
`seedSource`. That is MOTIR-5049's fix and not this asset's to make; it is named here because §7b's
rule is stated as a predicate over rows, and the place that predicate has to LAND is that line.

### ⚠️ v7 · WHAT THE STEP RENDERS WHEN GITHUB REFUSES — read off `origin/main` `78579f21d`

Same instrument as v6's block above, and for the same reason: the state needs a seeded tenant whose
GitHub call is refused, and what decides it is a GUARD rather than a pixel. **Every row names the
gate, so one `grep` per row checks it.** Four elements render for a user whose invitation GitHub
turned down, and **one of them is false — the one that is about the reader**:

| Element                                                                            | Gate in shipped code                                                   | After a REFUSAL                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `SectionLabel` **"Your project's code"** + `<h2>` **"Motir will host your code"**  | **NONE — rendered unconditionally**                                    | TRUE — Motir did host it                                                                           |
| ✅ **"Your code is ready"**                                                        | `state === 'ready'`                                                    | **TRUE, and it must stay true** — the repository exists and nothing was rolled back                |
| 🔒 **"It's yours. Motir keeps it safe and private…"**                              | `state === 'idle' \|\| state === 'ready'`                              | TRUE                                                                                               |
| ⚠️ **"Motir doesn't know your GitHub account yet"** + **Finish setting up access** | `state === 'ready'`, `AccessReport` arm B on `!login \|\| !anyInvited` | **FALSE.** Motir knows the account — it is `view.githubLogin`, and it is the account it just tried |

**Why the row stays `not_invited`, from the WRITE path rather than from a fixture.**
`projectRepoAccessService.grantAccess` stamps NOTHING on a refusal — _"a row-level GitHub refusal is
counted, never thrown"_, and its result carries a transient `failed` COUNT that no persisted column
mirrors. `lib/projectRepos/access.ts` says the same thing from the read side: absence is a state, and
`deriveAccessState(null)` is `not_invited`, _"the same answer as a row whose invite attempt failed
before it could be stamped."_ So `anyInvited` is false, arm B fires, and **the co-occurrence is
guaranteed rather than incidental** — exactly the form v6's block used, for the same reason it used
it.

**The DISCRIMINATOR is already on the view, and no new field is owed.** The step holds TWO logins and
they answer different questions:

| Field              | What it is                                                                                 | After a refusal |
| ------------------ | ------------------------------------------------------------------------------------------ | --------------- |
| `view.githubLogin` | _"The actor's connected GitHub login (grant 1), or null when not connected."_              | **the login**   |
| `row.access.login` | _"The GitHub login that was invited, or null when none has been"_ — stamped at invite time | **null**        |

**Arm C reads the first and arm A reads the second**, and a builder who reaches for `access.login` to
name _"the account Motir tried"_ renders an empty string — which is why this table is here and not
left to be inferred.

**And the DOOR was checked, not assumed.** `CodeAccessSettings.tsx` branches on
`person.reason === 'no_github_identity'`: with a login present and nothing sent it renders **"Not
invited yet"** · **"@{login} is ready to be invited"** and an **Invite** control. So
`/settings/project/code-access` is a correct and actionable destination for arm C, not merely a
plausible one — which is what §4 needed before it could keep the door unchanged.

**No new render was shot for v7, same form and a narrower reason than v6's.** Arm C composes ONE
element — `.access-note`, arm B's own `<p role="status">` — with different copy, and that element was
mirrored from the shipped `AccessReport` in v5 and is unchanged on `origin/main` since. What a render
would add is a photograph of a sentence this note already quotes; what it could NOT settle is the
guard, which is the whole finding, and which the table above settles by reading it.

---

## 3. Placement and the access path

**The step takes the CANVAS pane of the plan-detail box; the review rail stays.**

1. The card requires the step "in place, inside the plan-approval flow — **not a floating panel**."
   A `Modal` is exactly what that rules out; the canvas pane is the surface's own content region.
2. **Keeping the rail is what makes the step honest.** It already reads **Approved** and **"Added
   24 items to your backlog"**, so the user can see their plan is safe while answering. That is the
   visual form of ADR §4.3.
3. Once the plan has materialized, the canvas of proposals has served its purpose; replacing it is
   the truthful use of the space.

```
/plans/[id] ─[ Approve — add 24 items ]→ the step ─[ Continue ]→ the report ─────────────────→ live
 (planned)     materializes + derives    "Motir will   Motir sets    "Your code is ready"       (rail:
               the repo set              host your      it up +       + WHO was invited          "Your code
                                         code"          invites                                  is ready")
```

**The rail's outcome gains exactly one plain line — "Your code is ready" — and never a repository
count or name.** If nobody could be invited, that line reads **"Finish setting up access"** instead,
and §4's `created` arm B says the same words on the step itself.

**⚠️ v5 · THE ACCESS PATH INTO this step is re-read, and it is the reason for the whole revision.**
The question §3 answers is _"from which UI is this reached?"_, and the honest v5 answer has two
halves:

- **Forward, this step is reached exactly one way: by approving a plan**, which is unchanged from
  v4. It earns **no new left-nav entry** — it is an action inside an existing surface, not a
  first-class project VIEW (`notes.html` #99).
- **Backwards, it is no longer reachable as a repository DESTINATION at all**, and that is new. A
  user who wants to connect code they already have does not come here; they go to **onboarding**,
  because a project with no repository cannot be planned at all (MOTIR-4753). This step is
  downstream of that decision by construction, which is what makes deleting §6 safe rather than
  merely tidy.

**Re-entry (the no-dead-end guarantee) — kept, with every door moved OFF this step.** The set is
durable (ADR §4.4), so nothing is lost by leaving. What changed is where the doors are:

| Case                                | v4's door                          | v5's door                                                                    |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| setup didn't finish                 | §4 `failed` → **Try again**        | unchanged — it is about repositories this step is creating, so it stays here |
| the invitation is pending or unsent | panel 4 / panel 3's connect prompt | **`/settings/project/code-access`**, reached from §4 `created` arm B's door  |
| the user has code of their own      | panel 5's "I already have code"    | **onboarding** (`design/onboarding-migrate/` Panel 1) — never this step      |

The code-context surface (**MOTIR-1764** / Story MOTIR-1754) remains the durable home of the set
itself and is still **not drawn here**.

### Why this is a step and not a gate

- **Can the target user judge it?** The default asks one thing they can answer — _is it fine for
  Motir to host this?_ — and nothing they cannot.
- **Does answering it block their flow?** No, and neither does the access step. Approve materializes
  the plan **first**; the items are in the backlog before either is answered. **Continue** is a
  one-click accept of a default that is already correct, and **Later** on the access prompt leaves
  with the plan intact and the door open.

---

## 4. The default path (panels 1, 1b, 2) — the whole thing for most users

**Panel 1.** Overline, one serif statement, one sentence of body, **the ownership promise**, one
primary. Absent by design: repository name, role, account, count, rows, table chrome, seed source,
reorder, per-row menu, "add a repository". **v5: and no branch either** — the quiet
`repositorySet.iHaveCode` secondary led to §6's technical path, which has left for onboarding, so
the panel is now one statement, one guarantee and one action.

**The ownership promise is on the main line, not in a footnote.** ADR §3's amendment makes Motir the
default holder of every new project's code, which the ADR itself calls a trust surface "the product
copy must state plainly rather than let the user discover". So it is its own element — a `lock` icon,
_"**It's yours.** Motir keeps it safe and private — move it to your own GitHub whenever you want."_,
and the **door**: a `How moving it works` link into MOTIR-711's transfer. **The promise and its door
are drawn; the transfer flow is not** (9.3.7 owns it). It is styled as a quiet standing guarantee
(`--el-surface-soft`), not a severity tint, because it is a fact about the arrangement rather than a
warning about it.

**Panel 1b — both cardinalities.** The card's central problem, answered by **removing the
question**: the same screen ships whether the plan needs one repository or three. The two renders in
the mock are **identical pixels**; only what Motir does behind them differs. Nothing about
cardinality reaches the user, so a one-row set cannot look like a list of one and a three-row set
cannot look advanced. Where the difference DOES surface is the technical path (panel 6), which is
also the only place the count is spoken (**Set up 2 repositories**).

**Panel 2 — three states, in plain language.** The ADR's six per-row states are the _model_; this
path renders only what the user can act on:

| ADR state                                    | Default path                                                                                                                                           | Forward path                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `creating`                                   | **"Setting up your code…"** — one `role="status"` line for the whole set                                                                               | (resolves)                                                               |
| `created` · **arm A** (something was sent)   | **"Your code is ready"** + the ownership promise + the `IdentityHeader` naming the invited account                                                     | **Go to my backlog** · _Open the invitation_ · _Use a different account_ |
| `created` · **arm B** (no connected account) | the same, plus one `role="status"` line: _"Motir doesn't know your GitHub account yet"_ + its door                                                     | **Go to my backlog** · _Finish setting up access_                        |
| `created` · **arm C** (v7 — REFUSED)         | the same, plus one `role="status"` line: _"Motir couldn't give @{login} access to your code yet — GitHub turned the invitation down."_ + the SAME door | **Go to my backlog** · _Finish setting up access_                        |
| `failed`                                     | **"Motir couldn't finish setting up your code"** + what it costs (nothing yet)                                                                         | **Try again**                                                            |
| `proposed`                                   | **cannot occur** — nothing is proposed for approval on this path                                                                                       | —                                                                        |
| `connected` · `skipped` (v6)                 | **THE STEP IS NOT DRAWN.** This path no longer PRODUCES either state, but it is shown them — see **§7b**                                               | none; the canvas has the pane                                            |

**No per-repository progress, no repository name in the error, no GitHub status code** on this path.
The failure copy names the consequence in the user's terms — _"Your plan is safe in your backlog.
Nothing is lost — Motir will tell you if a task needs code that isn't ready yet"_ — which is the
honest hand-off to the code-blind signal MOTIR-1754 renders.

**⚠️ v5 · `created` is the state that REPORTS, and it is the whole of this revision.** In v4 it was
the one state that CONTINUED — into the access prompt — because the code existed and the user still
had to be asked for the account to invite. Motir now has that account before the plan can be
approved at all, so the invitation is sent at establish and this state says what happened.

**The three arms are not a branch the user chooses; they are what Motir knows.** Arm A is the
overwhelmingly common one — a project reaches plan approval through onboarding, and onboarding is
where GitHub was connected. Arm B exists because "connected" is a property of the ACTOR, not of the
project: a teammate who did not run onboarding can approve a plan, and inventing an invitation for
an account Motir does not have would be worse than saying so.

**⚠️ v7 · ARM C — the account is known and GITHUB REFUSED, and until v7 arm B was answering for it.**

**The three conditions, as predicates over `ProjectRepoEstablishViewDto` — checked in this order.**
Let `invitable` be the rows the product can actually invite to: `row.state === 'created'`
(`needsCollaboratorInvite`; a `connected` row is the organisation's and is never invited to, a
`skipped` / `failed` row has no repository behind it).

| Arm   | Condition                                                                              | Reading                                        |
| ----- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **B** | `view.githubLogin === null`                                                            | there is no account to invite                  |
| **C** | `view.githubLogin !== null` ∧ `invitable.every(r => r.access.state === 'not_invited')` | Motir had an account, tried, and nothing stuck |
| **A** | otherwise — some invitable row is `invited` or `accepted`                              | an invitation is out, or has been taken up     |

**Why C's condition is SUFFICIENT, said plainly, because it is the one claim here worth disputing.**
`not_invited` is not a record of a refusal — nothing is stamped on one (§2's v7 block) — so on its
own it cannot tell _refused_ from _never attempted_. The connected login is what closes that: since
v5 the invitation is **sent at establish**, in the same pass that creates the rows, so a set that
reached `created` while Motir held an identity has ALREADY had its invitation attempted. A known
account with nothing sent therefore has one explanation. **Arm C claims exactly that and no more** —
which is why its sentence says what Motir could not do rather than what GitHub's response was.

**Why arm C is drawn with arm B's treatment and not a louder one.** The arms are mutually exclusive
and only one is ever on screen, so the DISTINCTION the reader needs is carried entirely by the
sentence; a second hue would be a severity claim, and the severity here is settled — an invitation
failure never fails a row, so this must not read as a failed setup. Same `.access-note`, same
`--el-warning` `TriangleAlert`, same `--el-text-secondary` ink, same door. **The settings surface
tints ITS refusal `--el-danger`, and that is right there and wrong here**: that row is a work list
you went to in order to fix something, and this line sits four inches under _"Your code is ready"_.

**Arm C's door is arm B's door, and that is a decision with a reason.** Both point at
`/settings/project/code-access` with the label `repositorySet.outcomeNeedsAccess`, because it is the
surface that OWNS the repair and it already distinguishes the two states correctly — it renders **"@{login}
is ready to be invited"** with an **Invite** control for exactly arm C's state, and
_"Motir doesn't know your GitHub account yet"_ for arm B's (§2's v7 block has the branch). The rail
agrees for free: `codeOutcomeOf` resolves both arms to `needs_access`, which is true of both, so the
rail needs no change and none is proposed.

**What arm C must never say.** No GitHub status code, no repository name — the same rule the `failed`
state above carries, and for the same reason: a person reading this screen has no repository in mind
yet. The one identifier it DOES carry is the account, because the account is the thing the reader can
act on, and because a sentence about access that names no account cannot be checked by the person it
is about.

**Arm B says it in the rail's own words, by REUSING its key.** `PlanDetail.codeOutcomeOf` already
resolves a `created` row with `access.state === 'not_invited'` to `needs_access`, and
`PlanReviewRail` renders that as `repositorySet.outcomeNeedsAccess` — **"Finish setting up access"**.
The panel's door is that same key, not a second string that happens to match today. Its explanatory
sentence is the shipped `repositorySet.notInvitedDetail`, which `/settings/project/code-access` also
says about the same state (`settings.codeAccess.state.notInvitedSelf`). Three surfaces, one
sentence, because it is one fact.

**A report is not a silent surface.** Arm A keeps **Use a different account**, which re-runs the
connect rather than opening a field (§5's own rule, unchanged). It is not a residue of the ask: the
whole reason the account is SHOWN is that a typed handle could invite a stranger to a private
repository, and showing the user which account got admin while offering no way to correct it would
make that guarantee worse, not better. What v5 removed is the ASK for an identity Motir already
had.

---

## 5. The access step (panels 3–4) — ⚠️ SUPERSEDED AS A PROMPT IN v5; kept as the record

> **⚠️ v5 (MOTIR-5011): panels 3 and 4 are NOT DRAWN any more.** The section is kept, unedited below
> this box, because it is the reasoning behind decisions v5 depends on — which account gets access,
> why it is shown and never typed, why an invitation failure never fails a row — and deleting it
> would delete the reasons along with the panels. **Read it as history plus three live rules**, not
> as a specification of a surface:
>
> | What §5 held                                  | Status in v5                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
> | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **Panel 3, the connect PROMPT**               | **GONE.** The identity is obtained by onboarding's `connect` step; the invitation is sent at establish. Nothing on this step asks for an account                                                                                                                                                                                                                                                                                                                          |
> | **Panel 3b, the `IdentityHeader`**            | **LIVE, relocated** into §4's `created` arm A — it was always the REPORT rather than the ask                                                                                                                                                                                                                                                                                                                                                                              |
> | **_Which account gets access_ (below)**       | **LIVE, unchanged.** Connected, never typed, and therefore SHOWN. It is why arm A keeps **Use a different account**                                                                                                                                                                                                                                                                                                                                                       |
> | **Panel 4, the per-row invitation states**    | **LIVE, relocated** to `/settings/project/code-access`, which draws all three per person and per repository — and which branches `not_invited` on the DTO's `reason`, so it distinguishes arm B's cause from arm C's. `notInvitedDetail` also stays here, as arm B's line                                                                                                                                                                                                 |
> | **_An invitation failure never fails a row_** | **LIVE, and load-bearing.** Establish now carries the invite, so this is what keeps a refusal from costing the user their repositories — and MOTIR-5016's notification is its only ADDED user-visible consequence. **v7: "only" was wrong.** Not failing the row means the row stays `not_invited`, and §4's `created` panel RENDERS that state — so the refusal was always visible there, in arm B's words, which are about a different situation. §4's arm C is the fix |
>
> **The teammate-access gap below (MOTIR-1910) is NOT closed by v5** and is not narrowed by it
> either: v5 moves where the owner's own invitation is reported, and invites nobody new.

**Panel 3 — the connect prompt.** _"Get access to your code."_ Three properties are load-bearing and
each is drawn, not just asserted:

1. **It comes AFTER approval, and after the code exists.** Nothing about GitHub can cost the user
   their plan, because the plan is already in the backlog and the repositories are already made.
2. **It is not a gate.** **Later** is a real answer: it leaves with everything intact, and the rail's
   outcome says what is unfinished (**"Finish setting up access"**). The permanent door is
   MOTIR-1764's code-context surface.
3. **It asks for no permission.** Motir needs exactly one thing — the user's GitHub username — which
   is **grant 1 (identity)** of the shipped connect pane (`GithubIdentity.githubLogin`, which is
   where MOTIR-1900 reads it from). The **repository-access install is grant 2** and is needed only
   for connect-existing (panel 5), because that is the only path that reads a repository the user
   owns. No re-consent, upgrade, or org-owner state is drawn, because none is asked for.

Copy stays plain-language on this panel — _"Your code is private — only you and Motir can see it"_ —
because a user who has not connected has not yet self-identified as technical. **Repository names
appear only after they connect**, which is the same #151 discipline the "I already have code" door
applies, one step later.

### Which account gets access — connected, never typed, and therefore SHOWN

There is deliberately **no "type your GitHub username" field**. The account Motir invites is the one
the user **connects** — `GithubIdentity.githubLogin`, which is where MOTIR-1900 reads it. A typed
handle proves nothing (anyone can type anyone's), a typo would invite a **stranger** to a private
repository, and Motir needs the verified identity anyway for dispatch and attribution.

But that mechanism is only honest if the user can **see** which account got access, which v4's first
pass did not draw — it asserted _"Motir invited @yuezhu"_ in a sentence and offered no way to correct
it. **3b now mirrors the shipped `IdentityHeader`** (`app/(authed)/settings/workspace/_components/gitSettingsPrimitives.tsx`):
the avatar, **@login**, the `Pill severity="success"` **Verified** badge, and a trailing **Use a
different account** which re-runs the connect rather than opening a field. That is `notes.html` #73
applied — when the element already exists as shipped UI, the design SHOWS the real component rather
than redrawing a stand-in — and it is the same component the Git settings pane already puts a
`Disconnect` button on.

### ⚠️ Only the approving user — teammate access is a plan gap, filed as MOTIR-1910

MOTIR-1900 invites **the project owner**, and nothing planned anywhere invites anyone else. Every
repository is private and Motir-owned, so on a six-person workspace the other five cannot clone the
project's code by any path. Verified at rung 2 — `grep -rn "collaborator" lib app` returns nothing,
and a tenant search names no card that invites a non-owner.

It is **not drawn on this surface**, on purpose: a teammate is not standing at plan approval, so
their door belongs on a surface they actually reach (the code-context surface, MOTIR-1764, or project
settings). It also cannot reuse the owner's mechanism as-is — Motir cannot OAuth on a teammate's
behalf — so it resolves against workspace membership rather than a typed handle, and it multiplies
the CI-spend exposure MOTIR-1901 / MOTIR-1907 meter. **MOTIR-1910** carries all of that, and likely
needs a decision card ahead of it.

**Panel 4 — the invitation, per repository.** Access is granted per repository, so the invitation is
a **sub-state OF a created row**, never a row state of its own: the row keeps its
`created` / `failed` / `skipped` tint from §4.1 and the invitation is an extra line inside it. Two
things fall out of that for free:

- A `skipped` row has nothing to be invited to, so a partial set (panel 7) needs no special case.
- An invitation failure **never** fails the row — creation already succeeded, and MOTIR-1900 makes
  the invite a side effect after commit that degrades gracefully.

| Invitation state | How it reads                                                                                                          | Forward paths                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `invited`        | `Mail` in `--el-info` + **"Invitation sent"** · to `@login`, waiting to be accepted on GitHub                         | **Open the invitation** · **Resend invitation** |
| `accepted`       | `BadgeCheck` in `--el-success` + **"You have access"** · `@login` can clone and push                                  | (settled — nothing offered)                     |
| `not invited`    | `UserPlus` in `--el-warning` + **"Not invited yet"** · Motir doesn't know your GitHub account yet, in `role="status"` | **Connect GitHub**                              |

GitHub owns the acceptance, so Motir shows the truth and a way back to it rather than pretending to
know more than it does. Every state carries an icon **and** a word, never colour alone.

---

## 6. The technical path (panels 5–7) — ⚠️ LEFT FOR `design/onboarding-migrate/` IN v5

> **⚠️ v5 (MOTIR-5011): panels 5, 6 and 7 are NOT DRAWN any more, and their subject is not this
> asset's.** Connecting a repository the user already owns is **onboarding's** — drawn in
> [`design/onboarding-migrate/`](../onboarding-migrate/design-notes.md) Panel 1, and reached through
> the migrate wizard's `connect` step. A project with no repository cannot be planned at all
> (`parseRoutingVerdict` refuses `continue` when `!baseline.hasRepository`), so **a user standing at
> plan approval has already answered this question** and the door here was a second answer to it.
>
> **v5 records the move and removes the panels; it does NOT redraw them there.** That is deliberate:
> `design/onboarding-migrate/` already draws the `connect` step, and a design card that edits two
> areas' assets is two cards. If onboarding's own drawing turns out to be missing something these
> panels had, that is a card against **that** area — not a reason to keep a second copy alive here.
>
> **What this section is still FOR.** Everything below is unedited, and three things in it are
> decisions rather than pixels, worth reading before anyone redraws the same ground in onboarding:
> why a single quiet secondary replaced the `Segmented` (a two-way control with one real option is a
> lie about the choice on offer), why `Add a repository` and `Use one of mine` are never at the same
> weight on the same line (one asks _how many_, the other asks _where_), and the per-row state
> table's rule that **state is never colour alone** and **a state pill is not used on a tinted row**.
>
> **⚠️ And one fact MOTIR-5014 needed, verified rather than assumed: the establish
> step's repository row had exactly ONE importer — `RepositorySetStep.tsx`.**
> (MOTIR-5014 has since deleted it, which is why this names it rather than its path.) The settings room composes its own `TakeoverRow`, and
> `/settings/project/code-access` its own rows. So deleting the `own` and `set` modes **orphans that
> whole component and the ~40 `repositorySet.*` keys only it reads**; they are not carried by the
> room, and §10's reconciliation table lists each one with its true consumer so that the deletion is
> a decision rather than a discovery.

**Panel 5.** One short confirmation — **"Use the code you already have"** — then the **shipped**
connect flow. The re-wording matters: this door is an alternative **SOURCE**, not an alternative
**HOME**. Motir never creates a repository in the user's account, so "use your own GitHub instead"
described a destination that no longer exists; what survives is connect-existing.

**Panel 6.** Once connected, repository vocabulary is theirs to read: one row per part the plan
needs, with a plain-language gloss beside each role chip (`web` · _The app people use_; `api` ·
_The service behind it_), the derivation's **"why"**, and reorder + a `⋯` menu at two or more rows.
One row drops the chip, the suffix, the grip and the menu. **A created row's owner prefix is fixed**
(Motir's org — `motir-projects` in the mock is a stand-in; MOTIR-1779 provisions the real one and
nothing here depends on its name) and the **name** is the editable part, per ADR §1.4.

### The per-row control: why a single secondary replaced the `Segmented`

| Level         | Control                                                          | The question it answers                    |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| **Per row**   | one quiet secondary: **Use one of mine** ⇄ **Let Motir host it** | _where does THIS part live_                |
| **Set level** | **Add a repository**                                             | _the plan needs a part Motir didn't infer_ |

The `Segmented` is gone because it had one option left. It answered "where does this part live" with
**Create for me** vs **Use one of mine**, and the ADR amendment deleted the first: "create" no longer
means "in your account". A two-way control offering one real destination misrepresents the choice, so
the row now has a **default** (Motir creates it) and **one action** to leave it. The action's label
names the mode you would switch TO, so a connect-existing row offers **Let Motir host it** in the
same slot.

The original ambiguity fix still holds and is the reason the levels are drawn apart: "Add a
repository" and "use an existing repository" once sat **side by side on one line**, which made them
read as two ways of doing the same thing. One asks _where_; the other asks _how many_ — so they are
never at the same weight on the same line.

**Panel 7 — the per-row states, on this path only.**

| State       | How it reads                                                                                                                                                                                 | Forward paths                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `creating`  | Per-row `Spinner` + **"Creating…"** + _"Seeding it from the starter"_, in `role="status"`. Siblings keep working.                                                                            | resolves to `created` / `failed` **after a readiness read** (spike §4.2) |
| `created`   | `--el-success-surface` row · `CircleCheckBig` in `--el-success` + **"Created"** · the real `owner/name` as an external link · **plus its invitation sub-state** (panel 4)                    | (settled)                                                                |
| `connected` | `--el-notice-info-bg` row · `Link` in `--el-info` + **"Connected"** · _"nothing was created and nothing was changed in it"_                                                                  | (settled)                                                                |
| `skipped`   | Quiet `--el-surface-soft` row · `SkipForward` in `--el-icon-muted` + **"Skipped"** · what Motir will do about it                                                                             | **Create it after all** · **Use one of mine**                            |
| `failed`    | `--el-danger-surface` row · `TriangleAlert` in `--el-danger` + **"Couldn't create"** · the REAL reason, in `role="alert"` · the name field re-opened with the suffixed suggestion (ADR §1.5) | **Retry** · **Use one of mine** · **Skip this one**                      |

The gallery omits the invitation line from the `created` row only so each state reads on its own.
The two axes are independent by construction: `created` is about the repository existing,
`invited` / `accepted` / `not invited` is about the user being able to reach it, and neither can fail
the other.

**Rules the states obey**

- **Rows are independent** (ADR §4.2) — state lives on the row, so one spinner or failure never
  freezes or reverts a sibling. No set-level blocking overlay, and **no compensating delete**: a
  created repository is a real artifact, and removing it to tidy a report is the worse answer.
- **No state is a dead end** — `failed` and `skipped` keep every recovery, now or on a later visit
  (§4.1, §4.4).
- **State is never colour alone** — always an icon **plus a word** (finding #35), with
  `--el-text-strong` / `--el-danger-surface-text` ink over every tint.
- **No dashed or dotted border signals state.** The planning canvas already owns dashed for
  proposed nodes and red-hatch for cross-story dependencies; a hardcoded border-style also breaks
  the `data-style` shape axis.
- **A state pill is NOT used on a tinted row.** `Pill severity="danger"` is `--el-tint-rose` and
  `--el-danger-surface` is the _same value_, so a danger pill on a failed row is invisible — same
  for mint/`created` and muted/`skipped`. The tint goes on the **row**; the state is named in text
  beside its icon (`.row-state`). Only the role chip stays a `Pill tone="neutral"`, which has its
  own border and reads on every tint.

**The PARTIAL outcome** (end of panel 7) — created + failed + skipped in one set, still completable
(§4.3): a `role="status"` summary counting the truth, the primary becoming **Finish setup**, and
nothing pretending the failed row succeeded. Failure copy is now Motir-org-framed, because that is
where creation happens: a collision is _"Motir already hosts a repository called …"_, and a decline
is reported without blaming the user's account for a limit it never hit.

---

## 7. Panel 8 — what this becomes when the hosted agent ships

Drawn as a **variant**, explicitly not as the main line, so the correction v4 made cannot quietly
reverse itself. Today (8a) every user continues into panel 3, because before Epic 9 there is no
non-technical workflow at all. After Epic 9 (8b) the access step becomes **optional** for the founder
who never touches code — the hosted agent pushes, the preview deploys, and they validate the running
site — and stays **required** for the developer who wants the repository on their machine.

**No drawn surface changes between them**: same step, same copy, same states. Only which action is
primary after `created` changes — which is exactly why the access step is its own step (panel 3)
rather than a fourth branch welded into panel 2's `created` state, and it is the one thing MOTIR-1782
should keep swappable.

### ⚠️ v5 RE-READ — the variant's AXIS is gone, v5 draws 8b, and MOTIR-1782's swappability is retired

The paragraph above is v4's and is kept because it is what the two arms MEANT. **v5 deletes the
access step from both of them**, so the axis they turned on — _is the prompt primary?_ — no longer
separates anything: the step reports, and the primary is **Go to my backlog** before Epic 9 and
after it.

**The surviving question is smaller, and it is answered here rather than left open: is the REPORT
worth showing at all once the hosted agent pushes for the user?** **Yes — it stays, unchanged.**
Two reasons, and neither is about developers:

1. **The invitation is sent whether or not anyone ever clones anything.** A user has been granted
   admin on a private repository; a product that never mentions it is keeping a fact about their own
   access from them.
2. **The ownership promise sits directly above it** — _"move it to your own GitHub whenever you
   want"_ — and that is a promise nobody can act on without knowing which account holds the keys.
   Suppressing the report would leave the guarantee true and unusable.

The earlier reading — that access is an aside for developers — was a property of the **PROMPT**
(which cost a click and a decision), not of the **FACT** (which costs one line).

**8a is no longer drawn**, and its home is §0.1's revision history. A board that still draws a
retired control is a specification for putting it back, which is precisely how this surface came to
ask a question the product had already answered.

**And the swappability this section asked MOTIR-1782 to preserve is retired.** _"The one thing
MOTIR-1782 should keep swappable"_ was which action is primary after `created`; there is one action
now, in both eras. MOTIR-5015 does not need a seam here, and should not build one.

---

## 7b. Panel 9 (v6) — a SETTLED set draws NO STEP: the canvas has the whole pane

> **Numbering.** This is the ESTABLISH-STEP surface's panel 9. §17's _Panel 9_ belongs to the
> REPOSITORIES-ROOM surface (`repositories-room.mock.html`), which numbers its own panels 5–9. The two
> numbering spaces are per-surface, as the §0 index implies; this note is here so a reader arriving at
> _"panel 9"_ from either direction lands in the right one. Panels 3–7 stay retired and unreused.

### The answer in one line

**A project whose repository set has nothing left to establish does not see this surface at all.** No
band, no residue, no collapsed one-liner: the canvas fills the pane, and the only thing the reader is
told about their code is the review rail's own line, which is already there and already correct.

### Why the step has nothing to say — the argument, not just the rule

The step exists to do exactly one of two things: **ASK** Motir to establish code, or **REPORT** what
Motir established. A row Motir will not create and did not create gives it neither. §3's own
justification is the test: _"the default asks one thing they can answer — is it fine for Motir to host
this?"_ For a repository the organisation already owns, that question has no referent. It is not a
question the user can answer wrongly; it is a question about nothing.

This is also why the answer is ABSENCE rather than a third state. A state would have to say something,
and there is nothing true to say that the rail is not already saying — so any copy drawn here would be
filler in the most expensive position on the page, directly above the thing the user just approved.
**Part VI §4's stacking decision is untouched**: the band still takes a band and never the pane, for
every project that has code to establish. v6 adds the population where the band's height is zero
because the band is not there.

### The PREDICATE, by name — so the card that builds it has nothing to invent

**The band is drawn if and only if the set holds at least one row Motir ESTABLISHES:**

```
drawBand  ⟺  set.rows.some(r => r.state === 'proposed'  ||
                               r.state === 'creating'  ||
                               r.state === 'created'   ||
                               r.state === 'failed')
```

Equivalently, and this is the form to read it in: **a set whose every row is `connected` or `skipped`
draws no band.** Both fields are already on the wire — `ProjectRepoEstablishViewDto.set.rows[]`
carries `state` and `seedSource` — so nothing new is computed and no new read is needed.

**`state` is the discriminator, and the two plausible alternatives are both WRONG. Stated, because
each is the kind of thing a builder picks in good faith:**

| candidate                              | why NOT                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set.ownership` (`'user'`/`'motir'`)   | **Null for exactly this population.** Its own doc says `ownership` / `targetAccount` are _"null until the establish step decides"_ — and a settled set never ran the step, so the field is null precisely when it is needed                             |
| `isOrganizationSeedSource(seedSource)` | **Too narrow, and it answers a different question.** A `skipped` row is not organisation-sourced and still leaves nothing to establish; a `connected` row need not be the organisation's. It IS the right predicate for CUSTODY — see the promise below |
| `codeOutcomeOf(...) === 'ready'`       | **Cannot distinguish the two populations** — it counts `created` as settled too, so it is `ready` both for a set Motir just built (which DOES owe a report) and for one that arrived settled (which does not)                                           |

**So: `state` decides whether the band APPEARS; `seedSource` decides what the band may CLAIM.** Two
questions, two predicates, and conflating them is how the mixed set below goes wrong.

### What the reader is told instead — and the answer is "the rail, and that is enough"

**The review rail's existing approved-outcome line is the WHOLE answer.** For a settled set
`codeOutcomeOf` resolves `ready`, so the rail already renders ✅ **"Your code is ready"** beneath
_"Added N items to your backlog"_, with **View in backlog** under it. That sentence is true of an
organisation's own repository, claims nothing about who hosts it, and is in the place a reader is
already looking after a decision.

**Nothing is added to the rail, and that is a decision.** The tempting addition is one line naming
where the code lives. It is refused for the reason v2 was refused: it is a technical fact the reader
did not ask for, in a rail whose job is the DECISION's outcome, and a project's repositories have a
durable home already (`/settings/project/repositories`, which the room owns). **A reader who wants to
know where their code is has a room for it; a reader who does not should not be told twice.**

**One consequence to state plainly, because it is the cost:** a user approving a plan on a settled
project is told nothing NEW about their code at all. That is correct — nothing new happened to it.

### The MIXED set — one row Motir creates beside one the organisation owns

**This shape is reachable by construction, not hypothetically.**
`lib/services/organizationRepoService.ts` appends a row with `state: 'connected'` +
`seedSource: 'organization'` to whatever set the project already has (it takes the set's last position
and appends), so a project can hold an organisation row and a Motir row at once. MOTIR-5017 pins a
test on the shape.

**The band IS drawn** — there is a row to establish, so the predicate fires, and the step has a real
question to ask. What changes is what it may claim, and the two set-wide elements are exactly the ones
that over-claim:

| element                  | today                                                                                  | v6 for a mixed set                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `<h2>` **title**         | _"Motir will host your code"_ — **your code**, set-wide, and half of it is not Motir's | _"Motir will host the new code"_                                                                                   |
| 🔒 **ownership promise** | _"It's yours. Motir keeps **it** safe and private — move **it** to your own GitHub…"_  | _"It's yours. Motir keeps **the code it hosts** safe and private — move it to your own GitHub whenever you want."_ |

**Both edits are SCOPE, not information** — and that distinction is what keeps v2's rule intact. The
panel still names **no repository, no role, no account, no count and no rows**; nothing about
cardinality or about the set's composition reaches the reader. _"the new code"_ and _"the code it
hosts"_ are narrower subjects for the same two sentences, not a disclosure about the set. A reader
with an all-Motir set cannot tell the difference, which is the test a scope edit has to pass.

**Why not a second paragraph explaining the split?** Because that is the v2 mistake in miniature: the
user cannot act on it, and the honest place for _"which repositories does this project have"_ is the
Repositories room, which already splits its sections on `isOrganizationSeedSource` — the same
predicate, rendered where a reader went looking for it.

**Which predicate scopes the promise:** `isOrganizationSeedSource(row.seedSource)`. The promise speaks
for the rows Motir holds; a set with NO organisation row keeps v4's unscoped wording verbatim, so the
common case is byte-identical and the narrower copy appears only where it is needed.

> **⚠️ AND THE TITLE IS UNCONDITIONAL IN SHIPPED CODE TODAY — which is why this is a design decision
> and not a copy tweak.** `<h2>{t('title')}</h2>` sits outside every `state` branch, so it asserts
> _"Motir will host your code"_ in `working`, `ready` and `failed` alike, for every set. The settled
> population is the case where that is simply false; the mixed set is the case where it is half true.
> **Both are the same missing scope**, and a builder who fixes only the gate leaves the sentence
> standing. §2's v6 table is the element-by-element read.

### What this does NOT change

- **Part VI §4's stacking rule** — band above, canvas below, never replaced — for every project with
  code to establish. v6 narrows WHEN, never HOW.
- **Panels 1, 1b, 2 and 8** for the establish population: not one pixel, except the two scoped
  strings above, and those only on a mixed set.
- **§5 / §6's superseded status, and the retirement of panels 3–7.**
- **The `failed` arm stays on this surface** (§3's re-entry table): a failure is about repositories
  this step is creating, so it is still the step's to resume — and a set holding a `failed` row is not
  settled, so the predicate draws the band for it.

---

## 8. Primitives — every element, and what it is

| Element                           | Primitive                                                           | Notes                                                                                          |
| --------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Step statement                    | `h2` `font-serif`                                                   | 28px on the default + access paths, 22px on the technical one                                  |
| "Your project's code" overline    | `SectionLabel`                                                      | mono · 11px · 0.06em · `--el-text-eyebrow`                                                     |
| Primary action                    | `Button variant="primary"`                                          | `Continue` · `Connect GitHub` · `Open the invitation` · `Try again` · `Set up N repositories`  |
| Quiet secondary                   | a text button in `--el-link`                                        | `I already have code` · `Later` · `Go to my backlog` · `Use one of mine` · `Let Motir host it` |
| **Ownership promise**             | a callout `div` (`--el-surface-soft` + `--el-border-soft`) + `Lock` | a standing guarantee, not a severity tint; carries the transfer door                           |
| Default-path state line           | `Spinner` / lucide icon + text                                      | `role="status"` while working, `role="alert"` on failure                                       |
| **Per-row invitation line**       | lucide icon + a word + detail text                                  | `Mail` / `BadgeCheck` / `UserPlus`; inside the row, never its own row                          |
| A row container (≥2 rows)         | `Card` (untinted, `data-surface="card"`)                            | `--radius-card` · `--el-border` · row padding, not `--spacing-card-padding`                    |
| Repository name field             | `Input` (composing `FormField`)                                     | `addonStart` carries the fixed `motir-projects /` prefix; `error` variant on a failed row      |
| Existing-repository picker        | `Combobox`                                                          | over the repos the installation grants; "Grant more on GitHub" hands off to 7.10               |
| Role chip                         | `Pill tone="neutral"`                                               | mono; roles are metadata, not a status — no semantic tint is spent on them                     |
| Reorder / menu trigger            | icon `Button` at `--height-control` + `--radius-control`            | `ChevronUp` / `ChevronDown` / `Ellipsis`                                                       |
| Row `⋯` menu                      | `Popover` + a menu list                                             | `--radius-card` container, `--radius-control` rows, `--el-option-active-bg`                    |
| The "why" panel                   | a callout `div` (`--el-callout-bg`) + `Sparkles`                    | mirrors the shipped AI-proposal callout; not a `Tooltip`                                       |
| Row recoveries                    | `Button variant="secondary" size="sm"` + `ghost sm`                 | Retry / Open the invitation emphasized; the others quiet                                       |
| Rail (status · history · outcome) | **the shipped `PlanReviewRail`**                                    | reused verbatim                                                                                |

**`Segmented` is no longer used by this surface** (v3 used it for the per-row create/connect choice;
see §6). **No new primitive is introduced.** If MOTIR-1782 finds it needs one, that is its own
`design/` subtask, not an improvisation.

---

## 9. Token roles — colour (`--el-*`) and shape

Every value in the mock's `:root` block was **generated** from `packages/design-system/theme.css`
(the Tier-0 `@theme` + Tier-3 `:root,[data-appearance-scope]` blocks), so no hex was retyped and the
asset cannot drift. The only raw values in the file are the mock **board's own** backdrop and the
canvas grid-dot texture — non-semantic decoration, per the colour rule's carve-out. Every icon path
is generated from `lucide-react`'s `__iconNode` (the octocat mark verbatim from
`components/icons/GithubMark.tsx`, which lucide has no equivalent for). **Dark mode needs nothing
extra in the BUILT component:** every colour the step renders is an `--el-*` reference — verified
mechanically, zero `--color-*` and zero hex/`rgb()` in the authored rules and markup — so
`theme.css`'s `[data-theme='dark']` block re-skins it with no per-component work. The **asset
itself is light-only**, which is this repo's convention for `design/*.mock.html` (it embeds the
generated light token block, not the dark one); that is a property of the mock, not a gap in the
design.

| Element                                                                | Token                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step pane (behind the step)                                            | `--el-canvas`                                                                                                                                                                                                                      |
| Row container · rail card                                              | `--el-card` · `--el-surface` / `--el-surface-soft`                                                                                                                                                                                 |
| Statement / body / helper ink                                          | `--el-text` · `--el-text-secondary` · `--el-text-helper`                                                                                                                                                                           |
| Overline                                                               | `--el-text-eyebrow`                                                                                                                                                                                                                |
| **Ownership promise** · its border · its icon                          | `--el-surface-soft` · `--el-border-soft` · `--el-icon-muted`                                                                                                                                                                       |
| Field · combobox                                                       | `--el-page-bg` fill · `--el-input-border` · `--el-text-muted` prefix                                                                                                                                                               |
| Primary action                                                         | `--el-accent` / `--el-accent-text`                                                                                                                                                                                                 |
| Quiet secondaries and links                                            | `--el-link`                                                                                                                                                                                                                        |
| "ready" state icon · `created` row                                     | `--el-success` · `--el-success-surface`                                                                                                                                                                                            |
| **`invited`** icon · **`accepted`** icon · **`not invited`** icon      | `--el-info` · `--el-success` · `--el-warning`                                                                                                                                                                                      |
| **v5 · `created` arm B's line** (`.access-note`) · its icon            | `--el-text-secondary` · `--el-warning`                                                                                                                                                                                             |
| **v7 · `created` arm C's line** (`.access-note`) · its icon · its door | `--el-text-secondary` · `--el-warning` · `--el-link` (`--el-link-pressed` hover) — **arm B's, deliberately identical**; no new hue, no container, no shape token, because the element is a bare `<p role="status">` on `--el-card` |
| Invitation state WORD (on a tinted row)                                | `--el-text-strong`                                                                                                                                                                                                                 |
| `connected` row · its icon                                             | `--el-notice-info-bg` · `--el-info`                                                                                                                                                                                                |
| failure icon · `failed` row · its ink                                  | `--el-danger` · `--el-danger-surface` · `--el-danger-surface-text`                                                                                                                                                                 |
| `skipped` row · its icon                                               | `--el-surface-soft` · `--el-icon-muted`                                                                                                                                                                                            |
| The "why" callout · its sparkle                                        | `--el-callout-bg` · `--el-accent-on-surface`                                                                                                                                                                                       |
| Role chip                                                              | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                                                                                                                                                        |
| Rail status pill (Approved)                                            | `--el-tint-mint` + `--el-text-strong` (the shipped `STATUS_TINT`)                                                                                                                                                                  |

| Surface                                             | Shape token                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| Buttons                                             | `--radius-btn` · `--height-btn-md` / `-sm` · `--spacing-btn-x`         |
| Row container · callouts · promise · menu · the box | `--radius-card`                                                        |
| Field · combobox trigger                            | `--radius-input` · `--height-input` · `--spacing-input-x`              |
| Role chip                                           | `--radius-badge` · `--spacing-chip-x` / `-y`                           |
| Icon buttons · menu rows                            | `--radius-control` · `--height-control` · `--spacing-control-x` / `-y` |
| Menu elevation                                      | `--shadow-elevated`                                                    |

**No Tier-0 `--color-*`, no generic `--radius-sm/md/lg`, no raw `rounded-md` / `p-2` / `h-9`, no
invented hue.** The default and access paths are deliberately quiet (ink, accent, one state hue at a
time); the semantic spread — success, info, danger, warning, the lavender AI callout, the neutral
chip — lives where there are states to tell apart, so neither screen is grey-and-purple (finding #54)
and neither is a fruit salad.

---

## 10. Copy — every string, as `en.json` keys

Namespace **`repositorySet`**. MOTIR-1782 / MOTIR-1900 add these to `messages/en.json` **and**
`messages/zh.json` (the i18n-catalog parity test fails otherwise).

### The default path

| Key                  | String                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `overline`           | Your project's code                                                                                                 |
| `title`              | Motir will host your code                                                                                           |
| `lead`               | Your project's code lives with Motir, ready for your agents to start work.                                          |
| `promise`            | **It's yours.** Motir keeps it safe and private — move it to your own GitHub whenever you want.                     |
| `titleMixed` (v6)    | Motir will host the new code _(the `<h2>` when the set ALSO holds an organisation row — §7b)_                       |
| `promiseMixed` (v6)  | **It's yours.** Motir keeps the code it hosts safe and private — move it to your own GitHub whenever you want.      |
| `promiseDoor`        | How moving it works _(the link into MOTIR-711's transfer)_                                                          |
| `continueCta`        | Continue                                                                                                            |
| `iHaveCode`          | I already have code                                                                                                 |
| `working`            | Setting up your code…                                                                                               |
| `workingDetail`      | This takes a few seconds. Your plan is already in your backlog — you can leave this page.                           |
| `ready`              | Your code is ready                                                                                                  |
| `goToBacklog`        | Go to my backlog                                                                                                    |
| `setupFailed`        | Motir couldn't finish setting up your code                                                                          |
| `setupFailedDetail`  | Your plan is safe in your backlog. Nothing is lost — Motir will tell you if a task needs code that isn't ready yet. |
| `tryAgain`           | Try again                                                                                                           |
| `outcomeReady`       | Your code is ready _(the line added to the rail's outcome)_                                                         |
| `outcomeNeedsAccess` | Finish setting up access _(the rail's outcome when the user chose Later)_                                           |

### The access step (MOTIR-1900)

| Key                            | String                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessTitle`                  | Get access to your code                                                                                                                                                                                                    |
| `accessLead`                   | Your code is private — only you and Motir can see it. Connect GitHub and Motir will invite you to it, so you can open it, clone it, and point your own agent at it.                                                        |
| `connectGithub`                | Connect GitHub                                                                                                                                                                                                             |
| `accessLater`                  | Later                                                                                                                                                                                                                      |
| `accessWhichAccount`           | Motir invites the GitHub account you connect — you'll see which one.                                                                                                                                                       |
| `invitedTitle`                 | You're invited to your code                                                                                                                                                                                                |
| `identityVerified`             | Verified _(reuses `github.identity.verified` — the shipped `IdentityHeader`'s success pill)_                                                                                                                               |
| `identityCaption`              | This is the account Motir invited                                                                                                                                                                                          |
| `useOtherAccount`              | Use a different account _(re-runs the connect; it does NOT open a username field)_                                                                                                                                         |
| `invitedDetail`                | Accept the invitation on GitHub and your code is yours to clone.                                                                                                                                                           |
| `openInvitation`               | Open the invitation                                                                                                                                                                                                        |
| `stateInvited`                 | Invitation sent                                                                                                                                                                                                            |
| `invitedRowDetail`             | to {login}, waiting to be accepted on GitHub                                                                                                                                                                               |
| `resendInvitation`             | Resend invitation                                                                                                                                                                                                          |
| `stateAccepted`                | You have access                                                                                                                                                                                                            |
| `acceptedRowDetail`            | {login} can clone and push to this repository                                                                                                                                                                              |
| `stateNotInvited`              | Not invited yet                                                                                                                                                                                                            |
| `notInvitedDetail`             | Motir doesn't know your GitHub account yet                                                                                                                                                                                 |
| `notInvitedRefusedDetail` (v7) | Motir couldn't give @{login} access to your code yet — GitHub turned the invitation down. _(§4 arm C. `{login}` is `view.githubLogin` — the account Motir TRIED — never `row.access.login`, which a refusal leaves null.)_ |

### The technical path

| Key                   | String                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownTitle`            | Use the code you already have                                                                                                                                   |
| `ownLead`             | Motir will use repositories you already have instead of creating new ones. You pick which ones it may see, on GitHub — Motir never sees the rest.               |
| `letMotirHost`        | Let Motir host it                                                                                                                                               |
| `setTitle`            | Where should each part live?                                                                                                                                    |
| `setLead`             | Connected as {login}. Your plan separates the web app from the API, so Motir needs a home for each.                                                             |
| `roleGlossWeb`        | The app people use                                                                                                                                              |
| `roleGlossApi`        | The service behind it                                                                                                                                           |
| `useOneOfMine`        | Use one of mine                                                                                                                                                 |
| `nameLabelForRole`    | Name of the {role} repository                                                                                                                                   |
| `nameLabelOne`        | Repository name                                                                                                                                                 |
| `pickerLabelForRole`  | Repository to use for the {role}                                                                                                                                |
| `pickerLabelOne`      | Repository to use                                                                                                                                               |
| `pickerHint`          | Only the repositories you granted Motir appear here.                                                                                                            |
| `grantMore`           | Grant more on GitHub                                                                                                                                            |
| `seedStarter`         | Motir creates and hosts it · seeded from the Motir Next.js starter.                                                                                             |
| `seedInitialised`     | Starts with a README, a licence, a `.gitignore` and a CI stub — your first task in it builds the skeleton.                                                      |
| `monorepoHint`        | Everything lives here. Motir won't create anything.                                                                                                             |
| `whyTrigger`          | Why this repository?                                                                                                                                            |
| `whyApi`              | {n} of the {total} items you approved build a backend service, so Motir asked for a separate home for it. Remove this row to keep everything in one repository. |
| `addRow`              | Add a repository                                                                                                                                                |
| `rowActions`          | Repository actions                                                                                                                                              |
| `moveUp` / `moveDown` | Move up / Move down                                                                                                                                             |
| `removeRow`           | Remove                                                                                                                                                          |
| `skipRow`             | Skip this one                                                                                                                                                   |
| `setUpMany`           | Set up {n} repositories                                                                                                                                         |
| `notNow`              | Not now                                                                                                                                                         |
| `setupNote`           | The first row is your project's main repository. Nothing is created until you press Set up.                                                                     |
| `stateCreating`       | Creating…                                                                                                                                                       |
| `stateCreatingDetail` | Seeding it from the starter                                                                                                                                     |
| `stateCreated`        | Created                                                                                                                                                         |
| `createdDetail`       | Hosted by Motir · seeded from the Motir Next.js starter.                                                                                                        |
| `stateConnected`      | Connected                                                                                                                                                       |
| `connectedDetail`     | Your existing repository — nothing was created and nothing was changed in it.                                                                                   |
| `stateSkipped`        | Skipped                                                                                                                                                         |
| `skippedTitle`        | No repository for the {roleLabel}                                                                                                                               |
| `skippedDetail`       | Motir will plan around it, and say so when a task needs code that isn't there.                                                                                  |
| `createAfterAll`      | Create it after all                                                                                                                                             |
| `stateFailed`         | Couldn't create                                                                                                                                                 |
| `failedNameTaken`     | Motir already hosts a repository called {name}. Rename this one, or use one of yours instead.                                                                   |
| `failedDeclined`      | GitHub declined the request and nothing was created for this row. Motir will retry, or you can use one of yours instead.                                        |
| `retryRow`            | Retry                                                                                                                                                           |
| `summaryPartial`      | {created} created · {skipped} skipped · {unresolved} needs a decision                                                                                           |
| `finishSetup`         | Finish setup                                                                                                                                                    |
| `finishHint`          | Your plan is already in the backlog. Motir will tell you which tasks are waiting on a repository.                                                               |
| `finishSetupLink`     | Finish setting up repositories                                                                                                                                  |

**Added in v6, and NEITHER IS IN `messages/en.json` YET:** `titleMixed` and `promiseMixed`, the
mixed-set arm's two scoped strings (§7b). They are specified here and written by the card that builds
the arm — **this design writes no `en.json` entry**, exactly as §13 says. A builder adding them owes
the `zh` twins in the same pass.

**Removed in v4:** `createForMe` ("Create for me") and `whereRoleLives` (the `Segmented`'s group
label) — the control they belonged to no longer exists. `failedLimit` is replaced by
`failedDeclined`, because the repository limit it named was the user's account limit and creation no
longer happens there. `readyDetail` and `seeWhereItLives` fold into `promise` and the access step.

### ⚠️ v5 · THE RECONCILIATION — every `repositorySet.*` key, against the SHIPPED catalog

**This table is the specification MOTIR-5014 / MOTIR-5015 implement, so it is reconciled against
`messages/en.json` rather than against the three tables above.** Those were written at v4 and have
drifted from the catalog in both directions since; the drift is recorded at the end of this
subsection rather than quietly patched, because a table that disagrees with the catalog is how a key
gets deleted that something else still reads.

**Verified mechanically over the shipped tree at `origin/main` `a55348224`**: 87 keys in
`repositorySet` (81 flat + 6 under `role.*`), each grepped against its five possible consumers —
`RepositorySetStep.tsx`, `RepositoryRow.tsx`, `PlanReviewRail.tsx`, and the settings room's
`TakeoverModal.tsx` / `TakeoverRow.tsx`.

**⚠️ THE DISCRIMINATOR THAT MATTERS: _retired from this SURFACE_ is not _deletable from the
CATALOG_.** Six keys this step stops using are read by the takeover surface in project settings,
which this story does not touch. Deleting them with the modes would break a surface nobody was
looking at.

#### A · SURVIVES on the v5 step

| Key                                                                        | Where in v5                                                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `overline` · `title` · `lead` · `promise` · `promiseDoor` · `continueCta`  | panel 1 / 1b — the whole default screen                                                                                                                |
| `titleMixed` · `promiseMixed` (v6, **NOT YET IN THE CATALOG**)             | panel 1 — the MIXED-set arm ONLY (§7b); an all-Motir set keeps `title` / `promise` byte for byte                                                       |
| `working` · `workingDetail`                                                | panel 2 `creating`                                                                                                                                     |
| `ready` · `goToBacklog`                                                    | panel 2 `created`, BOTH arms                                                                                                                           |
| `identityCaption` · `useOtherAccount` · `invitedDetail` · `openInvitation` | panel 2 `created` **arm A** — the report                                                                                                               |
| `notInvitedDetail`                                                         | panel 2 `created` **arm B** — the line                                                                                                                 |
| `notInvitedRefusedDetail` (v7, **NOT YET IN THE CATALOG**)                 | panel 2 `created` **arm C** — the line. MOTIR-5036 adds it to `messages/en.json` AND `messages/zh.json` (the i18n-catalog parity test fails otherwise) |
| `outcomeNeedsAccess`                                                       | **arms B AND C's door label AND the rail's outcome** — one key, three places, which is what makes them agree (v7)                                      |
| `setupFailed` · `setupFailedDetail` · `tryAgain`                           | panel 2 `failed`                                                                                                                                       |
| `actionError`                                                              | the establish action's own failure                                                                                                                     |

`identityVerified` is **not a key** and never was — arm A's badge reuses the shipped
`github.identity.verified` from `IdentityHeader`. The v4 table listed it as one; it is corrected in
F below.

#### B · RETIRED from this surface, but **LIVE elsewhere — DO NOT DELETE**

| Key             | Section it leaves                     | Who still reads it                     |
| --------------- | ------------------------------------- | -------------------------------------- |
| `accessLead`    | §5 (panel 3)                          | `TakeoverModal.tsx` — project settings |
| `accessLater`   | §5 (panel 3)                          | `TakeoverModal.tsx`                    |
| `connectGithub` | §4 `created`, §5 (panel 3), §6 (rows) | `TakeoverModal.tsx`                    |
| `createdDetail` | §6 (panel 7)                          | `TakeoverRow.tsx`                      |
| `stateCreated`  | §6 (panel 7)                          | `TakeoverRow.tsx`                      |
| `stateFailed`   | §6 (panel 7)                          | `TakeoverRow.tsx`                      |

#### C · RETIRED and ORPHANED — no consumer survives, so these are the deletable set

**§4 · the default path.** `iHaveCode` — the door to §6, which has left for onboarding.

**§5 · the access step (the PROMPT half).** `accessTitle` · `accessWhichAccount` · `invitedTitle` ·
`accessError` · `resendInvitation`. (The invitation's own repair now lives on
`/settings/project/code-access` as `settings.codeAccess.resend`.)

**§5 · the per-row invitation states.** `stateInvited` · `invitedRowDetail` · `stateAccepted` ·
`acceptedRowDetail` · `stateNotInvited` — all three states are drawn by
`settings.codeAccess.state.*`, per person and per repository. `notInvitedDetail` is the ONE
exception and stays (set A).

**§6 · the technical path.** `ownTitle` · `ownLead` · `letMotirHost` · `setTitle` · `setLead` ·
`setLeadAnon` · `useOneOfMine` · `nameLabelForRole` · `nameLabelOne` · `pickerLabelForRole` ·
`pickerLabelOne` · `pickerPlaceholder` · `pickerHint` · `pickerEmpty` · `grantMore` ·
`claimedOption` · `seedStarter` · `seedInitialised` · `monorepoHint` · `whyPlanItemRole` ·
`whyPreplanPlatform` · `whyDefaultWeb` · `addRow` · `addRowName` · `rowActions` · `moveUp` ·
`moveDown` · `removeRow` · `skipRow` · `setUpOne` · `setUpMany` · `notNow` · `setupNote` ·
`stateCreating` · `stateCreatingDetail` · `stateConnected` · `connectedDetail` · `stateArchived` ·
`archivedDetail` · `stateSkipped` · `skippedTitle` · `skippedDetail` · `createAfterAll` ·
`retryRow` · `summaryPartial` · `finishSetup` · `finishHint` · **and all six `role.*` glosses**
(`web` · `api` · `mobile` · `shared` · `infra` · `other`).

**These are orphaned because `RepositoryRow.tsx` has exactly one importer, `RepositorySetStep.tsx`**
(§6's box). The settings room composes `TakeoverRow`, and code-access composes its own rows, so
nothing else picks them up.

#### D · NOT this surface's, and untouched

`outcomeReady` and `finishSetupLink` belong to `PlanReviewRail` (the `ready` and `unfinished`
outcomes). v5 touches neither, which is the point of MOTIR-5018's criterion that
`tests/e2e/plans-review.spec.ts` must pass unchanged.

#### E · NEW keys v5 introduces

**None.** Both arms are assembled from keys that already ship — which is the strongest evidence
available that v5 is a REMOVAL rather than a redesign, and it is why arm B can agree with the rail
"word for word" as a property of the code rather than as a promise in these notes.

#### F · The v4 tables' own drift, corrected here rather than left standing

**Listed above but NOT in the catalog** (specified, then shipped under different names — a key drawn
in a panel and absent from the table is a defect in the card that drew it, and the inverse is a
defect in this one): `whyTrigger` and `whyApi` shipped as `whyPlanItemRole` / `whyPreplanPlatform` /
`whyDefaultWeb`; `roleGlossWeb` / `roleGlossApi` shipped as the `role.*` sub-object;
`failedNameTaken` / `failedDeclined` never shipped as keys at all; `identityVerified` is an alias of
`github.identity.verified`, as its own row already said.

**In the catalog but absent from the v4 tables**: `accessError` · `actionError` · `addRowName` ·
`setLeadAnon` · `setUpOne` · `pickerEmpty` · `pickerPlaceholder` · `stateArchived` ·
`archivedDetail` · `claimedOption` · `whyDefaultWeb` · `whyPlanItemRole` · `whyPreplanPlatform` ·
the six `role.*` glosses. Each is classified in A–C above, so the reconciliation is total over the
shipped set rather than over what an earlier revision happened to write down.

### Accessible names — the superstring audit

A new control's accessible name must not **contain** an existing one, or `getByRole` starts matching
two things (the superstring-label class). Checked programmatically against all 4,367 strings in
`messages/en.json`:

- **`Later`** was chosen over "Not now", which this surface already uses at the technical path's set
  footer — two controls with the same name on one route is exactly the scoping problem the rule
  guards. "Skip for now" was rejected twice over: it contains **"Skip"**
  (`import.preview.actionSkip`) _and_ collides with this surface's own **Skip this one**. `Later`
  contains nothing in the catalog.
- **`Open the invitation`** was chosen over "Open invitation on GitHub", which would have contained
  **"GitHub"** (`shell.nav.github`, `github.title`, `publicProjects.github`) — a name already
  ambiguous across the app.
- **`Use one of mine`** was kept from v3 (chosen over "Connect existing", which would have contained
  the exact existing name **"Connect"**), and **`Let Motir host it`** is reused verbatim at BOTH
  altitudes — the step-level way back (panel 5a) and the row-level mode switch (panel 6). That is one
  name for one action rather than two near-duplicates; **note for MOTIR-1785: scope that locator to
  the row or the step under test**, never the page.
- **`Resend invitation`** contains **"Resend"** (`settings.profile.email.pending.resend`), on the
  account-settings surface only — no route renders both, so no locator can straddle them.
- **`Continue`**, **`Retry`** and **`Remove`** duplicate `auth.continue`,
  `dashboards.states.retry` and `settings.members.remove` **exactly**. Exact duplicates on other
  surfaces are fine and already the norm — only containment breaks a selector.
- **`Connect GitHub`** is the **same** name as the shipped Git-settings button, deliberately: it is
  the same action, and the E2E should be able to reach either by the same name. It now appears at
  three altitudes here (the access prompt, a `not invited` row, and panel 2's `created` state) —
  scope by container.
- **Within this surface**, no name contains another. **`I already have code`** appears on both the
  default step and the failure state, so scope that locator to the state under test rather than the
  page.

---

## 11. a11y

- **Every state carries text**, not colour alone (finding #35); tinted rows hold
  `--el-text-strong` / `--el-danger-surface-text` ink so AA holds in both themes. The three
  invitation states are `Mail` / `BadgeCheck` / `UserPlus` **plus** a word, so `invited` and
  `accepted` are distinguishable without hue.
- **v7 · the `created` arms are distinguished by their SENTENCE, never by hue**, which is what
  finding #35 asks for and is also why arms B and C share a treatment: they are mutually exclusive,
  only one is ever rendered, and the icon is the same `TriangleAlert` in `--el-warning` either way.
  Arm C's ink is `--el-text-secondary` on `--el-card`, the pair arm B already ships, so its contrast
  is arm B's — **measured rather than assumed**, both themes, from the resolved Tier-0 values:
  light `#5d5b54` on `#ffffff` = **6.80:1**, dark `#a4a097` on `#0f0f0f` = **7.35:1**. AA at any
  size in both; AAA in dark and just under it in light. It is `--el-text-secondary` and NOT
  `--el-text-muted` deliberately — the line is a statement about the reader's access, not a caption.
- **`role="status"`** on the default path's _Setting up your code…_, on each `not invited` row, and
  on the partial summary; **`role="alert"`** on the default path's failure sentence and on each
  failed row's reason — the row that failed announces itself, not the whole step.
- **The reorder affordance is keyboard-operable** — the grip is decorative (`aria-hidden`) and the
  real controls are **Move up** / **Move down**; drag is an enhancement, never the only path.
- **Every field has a real label** — visible at one row (**Repository name**), visually hidden but
  role-specific at ≥2 (**Name of the web repository**), so rows stay distinguishable to a screen
  reader even though the visible label is the role chip.
- **The `⋯` menu is a `Popover`** whose trigger is named **Repository actions** — a menu with a
  door, and never portaled to `document.body` (that breaks it inside Radix).
- **Long names must not blow out the row.** Every flex column carries `min-width: 0` and the full
  `owner/name` truncates — this repo's recurring horizontal-overflow class is a missing `min-w-0`.

---

## 12. Page state after the step's mutations (the enforced contract)

Setting up code — and then granting access — changes three surfaces, and they do **not** all refresh
the same way (`motir-core/CLAUDE.md`):

1. **The step's own state line / row** — the response IS the confirmation. Keep the returned state;
   do **not** `router.refresh()` it (the refresh re-reads and causes a visible revert). This now
   covers the invitation sub-state too: a **Resend invitation** response is the confirmation, not a
   reason to re-read the row.
2. **The rail's outcome card** (server-rendered from the plan review read) — `router.refresh()`
   reaches it, which is how **"Your code is ready"** / **"Finish setting up access"** appears.
3. **Any client island seeded from server props** — the code-context surface and any nav badge own
   their own state; `router.refresh()` cannot reach them, so they need an explicit refetch trigger
   (a provider tick). MOTIR-1782 does the ones that exist and leaves the rest to MOTIR-1764.

**Per-row polling is a fourth mechanism, not one of these three** (spike §4.2): each row's
`creating → created` transition is settled by a readiness read, so the row is an async job with its
own poll, and `router.refresh()` is neither how it starts nor how it finishes.

---

## 13. Explicitly OUT of scope here (so nothing is built twice)

- **The plan-approval surface, the canvas, the review rail** — shipped (MOTIR-847 / 1193 / 1194).
  Composed, not redrawn.
- **The GitHub connect / install screens** — 7.10. Only the hand-off is drawn, and only grant 1 is
  needed by the access step.
- **The collaborator-invite service itself** — MOTIR-1900. Its states are drawn; none of its code,
  credential handling, or failure taxonomy is designed here.
- **The code-context / index-freshness surface, and the code-blind planning signal** — MOTIR-1764
  (Story MOTIR-1754). Pointed at as the durable home of the set and of unfinished access; none of it
  drawn.
- **The claim / transfer flow** — ~~MOTIR-711 (9.3.7). Only the promise and its door are drawn.~~
  **Superseded 2026-07-31: it is now DRAWN, in this same area — [`takeover.mock.html`](./takeover.mock.html), §14
  below (MOTIR-1938 design → MOTIR-1939 surface; MOTIR-711 keeps the backend saga).** This line is
  the reason MOTIR-1938 exists: the promise and its door shipped while the room behind them did
  not, so the shipped `OwnershipPromise` renders the door UNLINKED on purpose. §14 is what lets
  MOTIR-1939 link it.
- **The repo-set table, the derivation service, the creation primitive** — MOTIR-1780 / 1881 / 1781.
  Behaviour is quoted; no schema or service is designed here.
- **The hosted agent, and anything that makes panel 8b real** — Epic 9. Panel 8 records the
  consequence; it does not design the agent, its dispatch, or the CI metering that gates it.
- **The multi-stack scaffold registry** — MOTIR-709 (9.3.5). The notes say honestly that a non-web
  repo starts near-empty until then, rather than implying a scaffold that does not exist.

---

---

# 14. `takeover.mock.html` — the TAKE-IT-OVER flow

**Subtask MOTIR-1938 (design gate, Principle #13).** The design reference for moving a
Motir-hosted repository to the user's own GitHub: the per-row action, the target picker, the costs
stated before the commit, and the asynchronous transfer + App re-install drawn as **durable,
re-promptable states**. Layout source of truth for **MOTIR-1939** (the surface); the saga behind it
is **MOTIR-711**.

- **Asset of record:** [`takeover.mock.html`](./takeover.mock.html); `.png` export
  [`takeover.png`](./takeover.png) (full-page, light theme, `deviceScaleFactor: 2`, width 1200).
- **Scope:** pixels and copy only. No React, no route, no `en.json` entries — MOTIR-1939's.

## 14.1 · The answer in one line

**Every Motir-hosted row carries one secondary action — `Move to my GitHub` — and everything after
it lives on the ROW, not in a dialog.** The decision (which account, and what it costs) is a modal;
the _waiting_ is a durable row state that survives a reload, says what the user must go and do, and
re-prompts every time it is seen.

## 14.2 · The flow was GROUNDED, not invented — every source, and what it decided

Nothing in this asset is a new product decision. Each element traces to a decided source:

| Drawn thing                                                                                                           | Decided by                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The state machine `requested → transfer_pending → awaiting_reinstall → done`, plus `failed`                           | **MOTIR-711** — _"model the states explicitly … so a transfer nobody accepts, or a re-install nobody finishes, is re-promptable rather than a wedged repo"_                                                                                                                  |
| **Per ROW, not per project**; taking over one row of three must not wedge the others (panel 8)                        | **MOTIR-711** — _"Per ROW, not per project. … Taking over one row of three is legitimate and must not wedge the others."_                                                                                                                                                    |
| `transfer_pending` is a real state, **not a spinner**; a personal-account target must accept ON GitHub (panels 4, 7b) | **MOTIR-711** step 2 — _"the call is asynchronous, and for a personal-account target the new owner must accept on GitHub, so `transfer_pending` is a real state resolved by a webhook or a poll, not a spinner"_                                                             |
| `awaiting_reinstall` exists at all, and why dispatch stops (panel 5)                                                  | **MOTIR-711** — _"a GitHub App installation is account-scoped … the flow must re-establish the grant on the new owner, or dispatch and the code-graph index silently stop working"_                                                                                          |
| Reaching `done` needs a real new installation, not just the transfer (panel 6)                                        | **MOTIR-711** step 4 — _"do not mark done on the transfer alone"_                                                                                                                                                                                                            |
| The already-yours row is a clean **no-op with no control** (panel 1)                                                  | **MOTIR-711** (_"a no-op for a row the user already owns"_) + ADR `project-repository-set.md` §3 / the 2026-07-30 amendment (a set mixes ownership only via a deliberate connect-existing row)                                                                               |
| The three cost lines, and the ban on "one click" (panel 3)                                                            | **`ci-minutes-allowance.md` §D** — the takeover option _"states its **real costs**: a GitHub account you own, an **asynchronous transfer you must accept on GitHub**, and a **re-install of the Motir App** on the new owner so dispatch keeps working. Never 'one click.'"_ |
| The billing framing sentence, quoted verbatim (panel 3)                                                               | **§D** — _"GitHub bills you for Actions directly from then on, and Motir stops charging CI credits"_                                                                                                                                                                         |
| "Actions come back on … even while your organization is out of credits" (panels 1, 3)                                 | **§G** — _"the transfer RESUMES Actions on the repository, unconditionally — even while the org is still exhausted"_                                                                                                                                                         |
| Motir stops billing this repo's CI after the move (panel 6)                                                           | **§5.4** — _"Metering STOPS at the transfer, because the owner login changes at the transfer itself"_                                                                                                                                                                        |
| The no-identity state reuses MOTIR-1900's connect prompt rather than drawing a second one (panel 2d)                  | **MOTIR-711** (_"the service returns the typed error the surface renders as MOTIR-1900's connect prompt"_) + this card's own instruction                                                                                                                                     |
| The takeover option is never hidden or gated on a stored identity                                                     | **§D** — _"never hidden, never disabled, and never gated on a stored identity — gating it on one would hide it from every user"_                                                                                                                                             |

**The design adds no state, no ordering and no policy of its own.** Where it had to choose, it chose
presentation (which surface a state lives on, what a line says), never behaviour.

## 14.3 · Drawn against SHIPPED reality — what was RENDERED first

Three of the things this asset composes already exist as running code or as shipped design assets.
Per `notes.html` **#73** — _"'design against shipped reality' means SEE the pixels, not read the
code"_ — all of them were **rendered before anything was drawn**, and the mock mirrors those renders:

1. **The establish step's repository row — shipped code (MOTIR-1782, merged in `cefe76c9`;
   DELETED with the technical path by MOTIR-5014, so this records what was rendered rather than a
   file to open).** ⚠️ **The card's premise that "the repo-set step ships as a mock" was already stale
   when this ran** — MOTIR-1782 landed the step as real components, so the row was rendered headless
   from its own source + the real compiled `globals.css` (a throwaway happy-dom render → Tailwind v4
   via `@tailwindcss/postcss` → Playwright). What the render corrected, that reading the `.tsx`
   alone would not have:
   - the row is a **flex pair** — a `min-w-0 flex-1` main column plus a `shrink-0` control column —
     not the mock's horizontal action group;
   - its padding is **`--spacing-card-padding` (24px)**, not the 16px `repository-set.mock.html`
     drew, so a takeover row is visibly roomier than the establish-step row it descends from;
   - the state is an **icon + a WORD** in `--el-text-strong`, and the tint sits on the ROW
     (`--el-success-surface` / `--el-notice-info-bg`), never in a `Pill`.
2. **`gitSettingsPrimitives.tsx` — `IdentityHeader` + `GrantRow`, shipped code.** Rendered the same
   way. Panel 5b **reuses** them; it does not redraw a stand-in (the exact MOTIR-1196 failure #73
   records).
3. **The two host design assets** — `repository-set.mock.html` panel 1 (the promise + its door) and
   `design/billing/ci-line.mock.html` panel 2 (the exhausted `Move repositories` option). Rendered
   with Playwright and **composed verbatim, including their copy**. Neither is redrawn.

**The shipped door is deliberately dead, and that is this card's whole reason for existing.**
`RepositorySetStep.tsx` renders the promise but _not_ its link, with the reason in a source comment:
_"a link to a 404 is a worse broken promise than no link, and a surface that draws a door owes a
real entrance."_ §14 is the entrance that lets MOTIR-1939 light it.

## 14.4 · Placement and the access path — three doors, one room

**The room is `/settings/project/repositories`.** Not a modal, not a page invented for the flow, and
not the code-context surface (MOTIR-1764) — that does not exist yet, and designing a room inside an
unbuilt host is the mistake-#130 shape (_"a design DEFERRED a capability to a 'downstream' that does
not provide it"_).

**Why the project-settings area is the shipped answer, verified at rung 2.**
`lib/settings/projectSettingsNav.ts` is a typed REGISTRY that drives three surfaces at once — the
settings rail, the ⌘K deep links, and a **totality test** that pairs every
`settings/project/**/page.tsx` route 1:1 with a registry entry. Its own comment states the
extension mechanism: _"A later admin story mounts its page by ADDING an entry here — no layout
change."_ So the new entry — `id: 'repositories'`, `group: 'general'`, `icon: FolderGit2`,
`access: browse` — is **not an extra surface this design invented**; it is the mount, and a page
without it fails the totality test.

**The three doors (panel 0), each drawn as a real affordance inside its host:**

| #   | Door                                                | Host                                                                          | Where it lands                             |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | `How moving it works` link in the ownership promise | the establish step, `/plans/[id]` (shipped mock + shipped `OwnershipPromise`) | `/settings/project/repositories`           |
| 2   | `Move repositories` secondary button                | the exhausted `Motir CI` billing card, `/settings/organization/billing`       | the same room, for this project            |
| 3   | `Repositories` rail row                             | the project-settings area itself                                              | the same room — the **permanent** way back |

**Door 3 is what makes the flow re-enterable**, and it is not optional: a `transfer_pending` that
sits for days must be reachable from somewhere that is always there, not only from an approval step
the user left weeks ago.

**⚠️ The org→project scope gap, drawn rather than papered over.** Door 2 lives on the **org**
billing panel, but a takeover is **per ROW** and rows belong to a **project**. So the room's header
carries the org-wide truth back: the paused banner names the _other_ projects Motir still hosts,
each a link, and says in words that moving this project's repositories does not move theirs. That
keeps ADR §D's _"ONE decision surface, N pointers"_ intact — the billing line remains the decision
surface and the room remains the place the decision is carried out — without letting an org-scoped
button silently act on one project and abandon the rest.

## 14.5 · The panels

| Panel                        | What it draws                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 · The doors**            | All three entrances, haloed, inside repros of their host surfaces, plus where each lands.                                                                                              |
| **1 · The room**             | `/settings/project/repositories` in the shipped settings shell: the paused-org banner, two `created` rows each with `Move to my GitHub`, and the already-yours row with **no action**. |
| **2 · Pick the target**      | 2a orgs loaded (personal first) · 2b the org lookup in flight · 2c the lookup failed, degraded not blocked · 2d **no GitHub identity** → MOTIR-1900's connect prompt, reused.          |
| **3 · The costs**            | The confirm step: the three real costs, each with its consequence, plus §D's verbatim billing sentence and §G's Actions-come-back reassurance.                                         |
| **4 · `transfer_pending`**   | The row as a durable waiting state — what to do, where, and a re-prompt.                                                                                                               |
| **5 · `awaiting_reinstall`** | 5a the row (with the dispatch consequence stated) · 5b the **shipped** install hand-off it points at, not redrawn.                                                                     |
| **6 · `done`**               | The row settles into the same shape a connect-existing row has always had — `Yours` — plus the one thing that really changed: who pays.                                                |
| **7 · `failed` + recovery**  | The single true failure (red), beside the two **non**-failures (peach) — an unaccepted transfer and an unfinished re-install, each re-promptable.                                      |
| **8 · One row of three**     | The set mid-move: three ownerships, three states, all legal at once, with a summary that counts the truth.                                                                             |

### Why the decision is a modal and the state is not

Everything in panels 2–3 is transient — pick a target, read the costs, confirm — so it is a
`Modal`. Everything in panels 4–7 **outlives that dialog**, survives a reload and must be
re-promptable, so it lives on the ROW. That split is precisely what stops `transfer_pending` from
being drawn as a spinner in a dialog nobody kept open, which is the failure MOTIR-711 names.

### Why the org list has three states, and the personal account has none

⚠️ **Rung-2 constraint, read from the shipped schema.** `GithubIdentity` (`prisma/schema.prisma`)
stores exactly one login — the user's **personal** `githubLogin` — plus their encrypted token. There
is **no stored organization list anywhere**, so the orgs are a live `GET /user/orgs`, which can be
slow and can fail. An instantly-populated org list would be a drawing of a system that does not
exist. The **personal account is never behind that call**, which is what lets a failed lookup
degrade to a working picker (2c) instead of a blocked flow.

**And the org target has a real third-party PERMISSION price, stated once.** Transferring into an
organization needs permission to create repositories there; GitHub refuses it otherwise. That is
said once under the list — not repeated on every org row, and not used to hide the option. This is
`notes.html` **#180**'s lesson applied one surface over: the failure mode it records is deciding
whose account a repository goes to _without pricing the third-party permission that answer commits
you to_. Panel 7a draws the refusal honestly rather than pretending it cannot happen.

> **Open question for MOTIR-711, recorded rather than assumed.** MOTIR-711 specifies the acceptance
> step for a **personal-account** target. Whether an ORG target also requires an acceptance/approval
> hop is a GitHub API semantic this design did not verify and does not decide. **The drawn states
> are correct under either answer** — `transfer_pending` is a durable, re-promptable state for any
> target, and `done` is gated on a real installation — so MOTIR-1939 needs no design change
> whichever way MOTIR-711 resolves it. Flagged here so it is a checked assumption, not a silent one.

## 14.6 · Primitives — every element, and what it is

| Element                                                                      | Primitive                                     | Notes                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each repository row                                                          | **the shipped `RepositoryRow` shape**         | `flex gap-3 rounded-(--radius-card) border p-(--spacing-card-padding)`; `min-w-0 flex-1` main column + `shrink-0` aside. Mirrored from a real render.                       |
| Role chip (`web` / `api` / `shared`)                                         | `Pill` `tone="neutral"`, `font-mono`          | The only pill on a row — it has its own border and reads on every tint.                                                                                                     |
| State (`Created` / `Yours` / waiting / `Couldn't move it`)                   | icon + word, `--el-text-strong`               | **Never** a `Pill` on a tinted row: `Pill severity="danger"` and `--el-danger-surface` are the same token value, so it would be invisible (finding #35, inherited from §9). |
| `Move to my GitHub`, `Accept it on GitHub`, `Install on GitHub`, `Try again` | `Button variant="secondary" size="sm"`        | Lives in the row's shipped `RowActions` strip — the same slot `Let Motir host it` already occupies. **No new row affordance is introduced.**                                |
| `Check again`, `Pick a different account`                                    | `Button variant="ghost" size="sm"`            | The quieter half of a recovery pair.                                                                                                                                        |
| `Move this repository`, `Continue`, `Connect GitHub`                         | `Button variant="primary"`                    | One primary per modal step, never two.                                                                                                                                      |
| `Cancel`, `Back`, `Later`                                                    | `Button variant="ghost"`                      |                                                                                                                                                                             |
| The decision dialog                                                          | `Modal`                                       | `--radius-modal` + `--shadow-modal`.                                                                                                                                        |
| The target picker                                                            | `Combobox`-family listbox                     | Grouped: **Your account** then **Your organizations**; the selected option carries a check, not colour alone.                                                               |
| The costs block                                                              | `Card`-family callout on `--el-surface-soft`  | Not a `Pill` list and not fine print — it is the step's substance.                                                                                                          |
| The billing consequence                                                      | notice on `--el-notice-info-bg`               | Informational, not a warning: it states a fact, not a risk.                                                                                                                 |
| The paused-org banner                                                        | notice on `--el-warning-surface`              | Mirrors the shipped billing card's own paused register.                                                                                                                     |
| Section eyebrows                                                             | `SectionLabel`                                |                                                                                                                                                                             |
| The re-install hand-off                                                      | **the shipped `IdentityHeader` + `GrantRow`** | From `gitSettingsPrimitives.tsx`, rendered and reused — 7.10 owns that pane; this flow links into it and adds nothing to it.                                                |
| The org-lookup spinner                                                       | `Spinner`                                     | One row inside the listbox, `role="status"`.                                                                                                                                |
| Settings rail + pane                                                         | the shipped settings AREA shell               | `SidebarNav` groups (General / Access / Work / Automation) from `PROJECT_SETTINGS_NAV`.                                                                                     |

## 14.7 · Token roles — colour (`--el-*`) and shape

**Three ownership/attention registers, each a palette token, each paired with an icon + a word.
No state is ever carried by colour alone, and no colour is invented** (the `--el-*`-only rule; the
`:root` block in the mock is GENERATED from `@motir/design-system/theme.css`, so nothing is retyped).

| Register              | Fill                   | Ink                        | Means                                                                                                                                                                                                |
| --------------------- | ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Motir-hosted, settled | `--el-success-surface` | `--el-text-strong`         | Created and running, Motir pays the CI. Same token the shipped `created` row uses.                                                                                                                   |
| **Yours**             | `--el-notice-info-bg`  | `--el-text-strong`         | The user owns it. **Deliberately the same fill the shipped `connected` row uses** — a repo that was taken over and a repo that was brought in are the same thing, which is the point of the promise. |
| **Waiting on you**    | `--el-warning-surface` | `--el-warning-text`        | `transfer_pending` / `awaiting_reinstall`. A third register on purpose: not settled, not broken — _the next move is yours, on GitHub_.                                                               |
| Failed                | `--el-danger-surface`  | `--el-danger-surface-text` | **Only** a request GitHub refused. An unaccepted transfer is NOT tinted as an error.                                                                                                                 |

| Element                        | Colour role                                                                                              | Shape role                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Row container                  | fill per the table above; `border-(--el-border-soft)` on a tint, `--el-border` untinted                  | `--radius-card` · `--spacing-card-padding`                                                              |
| State icon                     | `--el-success` / `--el-info` / `--el-warning` / `--el-danger`                                            | —                                                                                                       |
| Repo reference                 | `--el-link` (→ `--el-link-pressed`), mono; `--el-text` when there is nothing to link to yet              | —                                                                                                       |
| External-link + octocat glyphs | `--el-icon-muted`                                                                                        | —                                                                                                       |
| Helper / consequence copy      | `--el-text-helper`, escalating to `--el-text` for the load-bearing clause                                | —                                                                                                       |
| Role chip                      | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                              | `--radius-badge` · `--spacing-chip-x/y`                                                                 |
| Buttons                        | `--el-accent` / `--el-accent-text`; secondary `--el-button-border`                                       | `--radius-btn` · `--height-btn-sm\|md` · `--spacing-btn-x(-sm)`                                         |
| Modal                          | `--el-card` + `--el-border`                                                                              | `--radius-modal` · `--shadow-modal` · `--spacing-card-padding`                                          |
| Listbox + its options          | `--el-card`, active `--el-option-active-bg`, check `--el-accent-on-surface`                              | `--radius-card` (container) · `--radius-control` + `--spacing-control-x/y` (rows) · `--shadow-elevated` |
| Costs block                    | `--el-surface-soft` + `--el-border-soft`                                                                 | `--radius-card`                                                                                         |
| Billing-consequence notice     | `--el-notice-info-bg`, glyph `--el-info`                                                                 | `--radius-card`                                                                                         |
| Paused-org banner              | `--el-warning-surface` / `--el-warning-text`, glyph `--el-warning`                                       | `--radius-card`                                                                                         |
| Identity avatar                | `--el-avatar-fallback` + `--el-text-inverted`                                                            | circular (not style-dependent)                                                                          |
| `Verified` badge               | `--el-tint-mint` + `--el-text-strong`                                                                    | `--radius-badge`                                                                                        |
| Grant-row icon tile            | `--el-card-icon-bg` + `--el-card-icon-fg`                                                                | `--radius-control`                                                                                      |
| Settings rail                  | `--el-sidebar-bg` / `--el-sidebar-border`; active row `--el-sidebar-item-bg-active` + `--el-icon-active` | `--radius-control` · `--spacing-control-x/y`                                                            |
| Row menu button                | `--el-text-secondary`                                                                                    | `--radius-control` · `--height-control`                                                                 |

**AA holds by construction:** every tint carries `--el-text-strong` / `--el-warning-text` /
`--el-danger-surface-text` (all charcoal-family), never a mid-grey, and no page-level surface is
tinted.

## 14.8 · Copy — every string, as `en.json` keys

Namespace **`repositoryTakeover`**, except the two keys that belong to surfaces it extends.
⚠️ **Every key below needs a matching `zh.json` key or the i18n-catalog parity gate fails the PR**
(the same rule §10 carries).

### The keys that belong to surfaces this extends

| Key                         | English               |
| --------------------------- | --------------------- |
| `repositorySet.promiseDoor` | `How moving it works` |
| `settings.nav.repositories` | `Repositories`        |

_(`repositorySet.promise` is already shipped and unchanged. `promiseDoor` is the **one** string this
flow adds to the establish step — the link the shipped `OwnershipPromise` currently withholds.)_

### The room

| Key                   | English                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`               | `Repositories`                                                                                                                               |
| `lead`                | `Where {projectName}'s code lives. Motir hosts the repositories it created for you — move any of them to your own GitHub whenever you want.` |
| `summary`             | `{moving} moving · {hosted} hosted by Motir · {yours} yours`                                                                                 |
| `pausedTitle`         | `CI is paused — this organization is out of credits.`                                                                                        |
| `pausedBody`          | `Moving a repository to your own GitHub turns its Actions back on and GitHub bills you for them from then on.`                               |
| `pausedOtherProjects` | `Motir also hosts repositories for {projects} — moving this project's does not move theirs.`                                                 |
| `addCreditsInstead`   | `Add credits instead`                                                                                                                        |

### The row

| Key                    | English                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `moveAction`           | `Move to my GitHub`                                                                                                                                                                        |
| `stateYours`           | `Yours`                                                                                                                                                                                    |
| `yoursDetail`          | `You already own this one — nothing to move, and Motir never bills its CI.`                                                                                                                |
| `statePending`         | `Waiting for you to accept on GitHub`                                                                                                                                                      |
| `statePendingStale`    | `Still waiting for you to accept on GitHub`                                                                                                                                                |
| `pendingDetail`        | `GitHub sent the transfer to {login}. It stays here until you accept it there — nothing expires on Motir's side, and the repository keeps working in the meantime.`                        |
| `pendingDetailStale`   | `Sent to {login} on {date} and not accepted yet. Nothing is wrong and nothing was lost — the repository is still here and still working. Accept it on GitHub to finish, or just leave it.` |
| `acceptOnGithub`       | `Accept it on GitHub`                                                                                                                                                                      |
| `checkAgain`           | `Check again`                                                                                                                                                                              |
| `stateReinstall`       | `Install Motir on {login}`                                                                                                                                                                 |
| `stateReinstallStale`  | `Install Motir on {login} to finish`                                                                                                                                                       |
| `reinstallDetail`      | `The repository is yours — the transfer went through. Install the Motir app on {login} and tick {repo} when GitHub asks which repositories it may see.`                                    |
| `reinstallDetailStale` | `It's yours and it stays yours. Motir just can't reach it to dispatch work until the app is installed on {login} with this repository selected.`                                           |
| `reinstallConsequence` | `Until you do, Motir can't dispatch work to this repository — your plan and your history are untouched.`                                                                                   |
| `installOnGithub`      | `Install on GitHub`                                                                                                                                                                        |
| `doneDetail`           | `Moved to {login} on {date}. GitHub bills you for Actions on it from now on, and Motir no longer charges CI credits for it. Dispatch is working.`                                          |
| `stateFailed`          | `Couldn't move it`                                                                                                                                                                         |
| `failedOrgPermission`  | `GitHub declined the transfer to {owner} — you need permission to create repositories in that organization. The repository is still here and still works; nothing was changed.`            |
| `tryAgain`             | `Try again`                                                                                                                                                                                |
| `pickDifferentAccount` | `Pick a different account`                                                                                                                                                                 |

### The decision (modal)

| Key                        | English                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modalEyebrow`             | `Move a repository`                                                                                                                                                                   |
| `modalEyebrowStep2`        | `Move a repository · step 2 of 2`                                                                                                                                                     |
| `modalTitle`               | `Move {repo} to your GitHub`                                                                                                                                                          |
| `modalTitleTarget`         | `Move {repo} to {login}`                                                                                                                                                              |
| `modalLead`                | `Motir transfers this repository out of its organization and into yours. Your work items, history and dispatch stay exactly where they are.`                                          |
| `targetLabel`              | `Where should it go?`                                                                                                                                                                 |
| `targetGroupPersonal`      | `Your account`                                                                                                                                                                        |
| `targetGroupOrgs`          | `Your organizations`                                                                                                                                                                  |
| `targetPersonalCaption`    | `Your personal GitHub account`                                                                                                                                                        |
| `orgsLoading`              | `Looking up your organizations…`                                                                                                                                                      |
| `orgsLoadingHint`          | `You can go ahead with your personal account — the lookup only adds organizations.`                                                                                                   |
| `orgsFailed`               | `Motir couldn't reach your GitHub organizations just now, so only your personal account is listed.`                                                                                   |
| `orgsRetry`                | `Try again`                                                                                                                                                                           |
| `orgPermissionNote`        | `Moving into an organization needs permission to create repositories there — GitHub refuses the transfer otherwise, and Motir says so rather than silently hiding the option.`        |
| `costsHeading`             | `What this takes`                                                                                                                                                                     |
| `costAccount`              | `A GitHub account you own.`                                                                                                                                                           |
| `costAccountDetail`        | `It goes to {login}, the account you connected.`                                                                                                                                      |
| `costTransfer`             | `A transfer you accept on GitHub. It isn't instant.`                                                                                                                                  |
| `costTransferDetail`       | `GitHub asks {login} to accept it. Nothing moves until you do, and nothing expires on Motir's side while you take your time.`                                                         |
| `costReinstall`            | `Re-installing the Motir app on the new owner.`                                                                                                                                       |
| `costReinstallDetail`      | `An app installation belongs to an account, so it does not travel with the repository. Until you re-install, Motir can't dispatch work to it.`                                        |
| `billingConsequence`       | `GitHub bills you for Actions directly from then on, and Motir stops charging CI credits.`                                                                                            |
| `billingConsequenceDetail` | `The code is yours either way — this changes who pays for the compute. Actions come back on for this repository as part of the move, even while your organization is out of credits.` |
| `confirmCta`               | `Move this repository`                                                                                                                                                                |
| `back`                     | `Back`                                                                                                                                                                                |
| `cancel`                   | `Cancel`                                                                                                                                                                              |
| `connectTitle`             | `Connect GitHub first`                                                                                                                                                                |
| `connectWhy`               | `Motir needs one thing to move a repository to you: the GitHub account it belongs to. It is the same account it invites you to your code with — you'll see which one.`                |

_(`connectTitle`'s body copy and its `Connect GitHub` / `Later` actions are **MOTIR-1900's**
existing strings, reused verbatim. This flow adds no second connect prompt.)_

**The copy rule that governs all of it, quoted from `ci-minutes-allowance.md` §D: never "one
click."** No string above says "instantly", "in one click", "just", or "simply". `costTransfer`
says the opposite in the affirmative — _"It isn't instant"_ — because the ADR's honesty requirement
is the point of the whole panel, not a caveat under it.

## 14.9 · a11y

- **Every state is icon + word**, never colour alone; the words are distinct
  (`Created` / `Yours` / `Waiting for you to accept on GitHub` / `Install Motir on {login}` /
  `Couldn't move it`), so a screen-reader user gets the same state a sighted one does.
- **The waiting states are `role="status"`**; the transfer failure is `role="alert"` — a refusal
  interrupts, a wait does not.
- **The org-lookup spinner row is `role="status"`** with a real label
  (`Looking up your organizations…`), never a bare animated element.
- **Accessible names carry the repository**, because a room lists several rows and
  `Move to my GitHub` × 3 is ambiguous: each row's action takes an `aria-label` of the form
  `Move {repo} to my GitHub`. Same for `Check again` / `Install on GitHub`.
- **No superstring collisions** with the establish step's names: `Move to my GitHub` is not a
  superstring of any shipped `repositorySet` label, and `Yours` is a new state word rather than a
  reuse of `Connected` (which stays the establish step's).
- **The listbox rows carry no action buttons** — a `role="option"` cannot hold one
  (the `listbox-row-actions` a11y rule); the permission note is a helper under the list, not a
  control inside it.
- **The picker is operable without the org lookup**: the personal option is present and selectable
  from first paint, so a failed or slow network never traps keyboard focus in an empty listbox.

## 14.10 · Page state after the takeover's mutations

The room is a settings page, so route each surface by HOW it renders (the enforced contract):

1. **The row that was acted on** — the mutation returns the row's new state; keep the optimistic
   value. Do **not** `router.refresh()` the row's own cell.
2. **The header summary** (`{moving} moving · {hosted} hosted by Motir · {yours} yours`) and the
   paused banner — server-rendered from the set read, so `router.refresh()` updates them.
3. **`transfer_pending` / `awaiting_reinstall` resolve OUT OF BAND** — by MOTIR-711's `repository`
   `transferred` webhook or an installation landing, neither of which is a click on this page. So
   `Check again` is a real re-read, and the row is a **polled async job** (the same fourth mechanism
   §12 records for `creating → created`), not something `router.refresh()` can be relied on to
   settle.

## 14.11 · Explicitly OUT of scope here

- **The saga itself** — MOTIR-711: the Actions re-enable ordering (§G), the transfer call, the
  `repository` `transferred` webhook handler, idempotency, the row lock. Its states are drawn; none
  of its code, credentials or failure taxonomy is designed here.
- **The GitHub connect / install screens** — 7.10. Only the hand-off is drawn, and it is the shipped
  components, reused.
- **The connect prompt** — MOTIR-1900. Reused, not redesigned.
- **The billing panel's exhausted state** — MOTIR-1902 / MOTIR-1903. Its `Move repositories` option
  is composed as a door; nothing about that card is changed here.
- **The establish step** — MOTIR-1778 / MOTIR-1782 (§0–§13 above). The only thing this asset adds to
  it is the one `promiseDoor` string.
- **Bulk / org-wide takeover** — not drawn, because MOTIR-711 is explicitly **per row**. The room
  names the other projects Motir hosts and links to them; it does not offer to move them.
- **Cancelling a pending transfer** — not drawn: MOTIR-711 models no cancel, and a control the saga
  cannot honour would be a worse promise than none.
- **The code-context surface** — MOTIR-1764. When it lands it can mount this same room as a
  component; the route chosen here exists today, which is why it was chosen.

---

# 15. `team-access.mock.html` — WHO ELSE ON THE TEAM CAN CLONE THE CODE

**Story MOTIR-1775 · subtask MOTIR-1944 (design gate, Principle #13).** §15 is the layout source of
truth for **MOTIR-1945** (the surface), which renders against **MOTIR-1910**'s per-member record and
DTO.

- **Asset of record:** [`team-access.mock.html`](./team-access.mock.html) — the source of truth,
  built from the real design system. Its `.png` export ([`team-access.png`](./team-access.png)) is
  the board/PR-visible face.
- **Scope:** pixels and copy only. No React, no route, no `en.json` entries, no schema — those are
  MOTIR-1945's and MOTIR-1910's.

## 15.1 · The answer in one line

**Access to a project's code is a property of the people who can already edit the project — so it is
drawn as a list of PEOPLE, in project settings, beside the pane that already lists them.** Every
member sees where everyone stands; only an admin can act on someone else; and the one action a
person can only take for themselves — connecting GitHub — is offered on their own row and nowhere
else.

## 15.2 · Every decided answer came from MOTIR-1943 — this asset decides ONE thing

`docs/decisions/project-repository-set.md` §3, _"Amendment 2026-07-31 (Yue · MOTIR-1943) — TEAM
access"_, answers five questions. **Nothing in this asset re-opens one**, and each is cited where it
is drawn:

| Q      | The decision                                                                                                                      | Where it is DRAWN                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Q1** | The invitable set = the members the shipped `canEdit` policy returns true for, enumerated with `assignableMembersService` scoping | Panel 1's two cards — **People** (invitable) and **Not eligible** — and panel 2's `not eligible` state |
| **Q2** | A teammate is invited at `push`; the approving user keeps `admin`. **Per-invitee data**, not one product-wide value               | The trailing `Pill` on each row, and the per-repository permission chip in panel 3's expansion         |
| **Q3** | `Connect GitHub` is offered to a member for their OWN identity only; a viewer of that row sees a reason, never a dead action      | Panels 2 (`not_invited` · seen by someone else) and 4 (the same row, seen by Dana)                     |
| **Q4** | Project settings, **on or beside** _Access & members_ — "a section within that pane or a sibling pane is MOTIR-1944's to draw"    | §15.3 decides it; panel 0 draws both doors                                                             |
| **Q5** | No new CI guard — the pool grows with the members added to it, and MOTIR-1907's gate is count-independent                         | Nothing meters, caps, warns about spend or refuses a push anywhere in the asset                        |

**The one open thing this card decides is Q4's remainder: section vs. sibling pane.** It is a
**sibling pane**, and §15.3 gives the reasons.

## 15.3 · Placement and the access path — one room, two doors

**The room is `/settings/project/code-access`** — a new entry in the `Access` group of
`lib/settings/projectSettingsNav.ts`, directly under `members`:

```ts
{ id: 'code-access', group: 'access', href: '/settings/project/code-access',
  icon: KeyRound, labelKey: 'nav.codeAccess', access: browse },
```

**Why a sibling pane rather than a section inside Access & members** — four reasons, in the order
they mattered:

1. **It is a table with its own states, not a field.** Six per-member states, four non-happy page
   states, two viewpoints and a second (per-repository) dimension. The Access & members pane is
   already a `max-w-[42rem]` column carrying a four-option access control, a member editor and the
   build-in-public card; a matrix appended to its foot would be the least-read thing on the longest
   page in the area.
2. **The registry IS the shipped mount, and it comes with a guard.** `projectSettingsNav.ts` states
   its own extension rule — _"A later admin story mounts its page by ADDING an entry here — no
   layout change"_ — and drives the rail, the ⌘K deep links, and a **totality test** that pairs every
   `settings/project/**/page.tsx` route 1:1 with an entry. A pane cannot silently lose its door; a
   section inside another pane has no such guard.
3. **A teammate has to reach it, and `browse` is the right gate.** Both panes are browse-gated, so a
   non-admin reaches this one exactly as easily — and unlike the members pane, this one has something
   a non-admin can DO (connect their own GitHub). Burying that inside an admin-shaped editor would
   contradict Q3's whole point.
4. **The data's scope matches.** `ProjectRepo` is project-scoped, so a project-settings home is the
   scope the rows already have.

**The two doors, each drawn as a real affordance inside its host (panel 0):**

| #   | Door                                                         | Host                                      | Why it exists                                                                                                                                                                                                |
| --- | ------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The **`Code access`** rail row                               | the project-settings area                 | The permanent way in — a rail entry with `KeyRound`, second in the `Access` group. This is the mount; without it there is no page.                                                                           |
| 2   | The **`Code access` card** at the foot of _Access & members_ | the shipped `ProjectMembersSettings` pane | The two panes answer the same question one level apart. It carries the COUNT (`4 of 5 people who can edit can clone this project's code`), so "is anybody locked out?" is answered without leaving the pane. |

**Why door 2 carries a number and not just a label.** The failure this whole Story exists to fix was
INVISIBLE: five of six people could not clone their own project's code and nothing said so anywhere.
A door labelled only "Code access" would reproduce that — the count is what makes the gap legible
from the surface people already visit.

**Rejected placements, and by whom.** The code-context surface (MOTIR-1764) and the plan-approval
step were both ruled out by MOTIR-1943 Q4 — the first is about index freshness rather than people,
the second by §5's own words ("a teammate is not standing at plan approval"). Neither is re-argued
here. `/settings/project/repositories` (§14.4's room) was NOT chosen either: that room is about the
REPOSITORIES — ownership, transfer, state — and Q4 decided the people axis owns this surface. The two
rooms are one rail apart and each is one click from the other.

## 15.4 · Drawn against SHIPPED reality — what was RENDERED first

Every surface this composes into already exists, so it was **rendered before anything was drawn** —
a production build (`pnpm exec next build` + `next start`) of `origin/main` @ `cac445bb`, signed in
against a seeded six-person workspace (Northwind / project Atlas), screenshotted at 1440 wide. Not
reasoned from the `.tsx` (`notes.html` **#73**).

| Rendered                                                      | What the render CHANGED about the drawing                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings/project/members` (page + `ProjectMembersSettings`) | The member row is mirrored element for element: `flex items-center gap-3 border-b border-(--el-border-soft) py-3`, a `size-8 rounded-full bg-(--el-text)` initials disc, `min-w-0 flex-1` name/email column, trailing controls. The pane column is `max-w-[42rem]`, the title is `font-serif text-3xl`, and the `Card` header is heading + count `Pill` on the left with the control on the right — all copied from the render, not guessed. |
| The project-settings **rail** (SidebarNav's settings swap)    | The real group order is General / Access / Work / Automation, with `Members & access` alone in Access — so the new row lands as the SECOND Access entry, and panel 0 draws the rail with its real header (`Back to Atlas` + the `AT` / Atlas / ATL identity block).                                                                                                                                                                          |
| `gitSettingsPrimitives.tsx` `IdentityHeader`                  | Reused as-is for the connected-account line in panel 4 — the `--el-avatar-fallback` disc, `@login`, the `Pill severity="success"` **Verified** badge, the caption, and the trailing **Use a different account**. Not a redrawn stand-in (the same #73 fix §5's panel 3b applied).                                                                                                                                                            |
| `design/repository-set/repository-set.mock.html` panel 4      | The invitation line is **composed**, not redrawn: same icons, same words, same `--el-*` roles, same forward paths.                                                                                                                                                                                                                                                                                                                           |

The token and icon layers of the mock are **generated** from `@motir/design-system/theme.css` and
`lucide-react` (the octocat path verbatim from `components/icons/GithubMark.tsx`), so no value is
retyped and the asset cannot drift from the shipped layer.

## 15.5 · The matrix is two-dimensional — and it is drawn MEMBER-primary

**N members × M repositories, granted per repository.** The surface has to pick an axis, and it picks
the member:

- **The member axis carries the DECISIONS.** Eligibility (Q1) and a connected identity (Q3) are
  properties of a PERSON and settle every repository in the set at once. The repository axis varies
  only the invitation mechanics — and even that rarely, because `projectRepoAccessService.grantAccess`
  walks the whole set with one login in one pass.
- **The question the surface answers is person-shaped.** "Can Dana clone our code?" — not "who is on
  atlas-api?". That is also the grammar of the pane beside it, which is the point of putting them
  side by side.
- **Repo-primary would multiply the rows by M and the reasons by nothing.** Six people on a
  three-repo project is 18 rows, of which 12 restate a reason that belongs to a person.

**So: the SET is named once, at the top of the card** — one `mono` chip per repository, the M axis
made visible without repeating it 6 times — and each member is one row.

**The row's headline is a ROLL-UP across the set, and it never averages away disagreement:**

| Across the set                  | The row reads                                                                |
| ------------------------------- | ---------------------------------------------------------------------------- |
| every repository `accepted`     | **Has access** · `@login` can clone and push to all 3                        |
| any repository failed           | **Couldn't invite** · GitHub turned the invitation down on _repo_            |
| some `invited`, some `accepted` | the pending word, with the count on the expander (`3 repositories · 2 sent`) |
| every repository `not_invited`  | **Not invited yet** + the reason (identity or nothing asked yet)             |

**The expansion is the second dimension, on demand** (panel 3): a per-repository list — octocat +
mono repo name + the **permission chip** (Q2: `push` for a teammate, `admin` for the approving user)

- that repository's state word. It **opens by default when the repositories disagree** and stays
  closed when they agree, so the common three-repo case reads as one line and the case that genuinely
  needs three lines gets them.

**Design it as a SET whose degenerate case is one.** A single-repo project renders the identical
markup: one chip in the set strip, and rows that never open because one repository cannot disagree
with itself. There is no second code path and no "if M === 1" copy.

## 15.6 · The states — every one drawn, with its reason and its forward path

The first three ARE `design/repository-set` §5's vocabulary, derived by
`lib/projectRepos/access.ts` (`PROJECT_REPO_ACCESS_STATES` = `not_invited | invited | accepted`).
**There is no second vocabulary.** The last three are not row states at all — they are reasons a
member has no row to be in, which is exactly why they could not exist on the single-user step.

| State                                                 | Icon + word (`--el-*` on the ICON)                    | The reason it shows                                                      | Forward path                                                          |
| ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `accepted`                                            | `BadgeCheck` · **Has access** · `--el-success`        | `@login` can clone and push to all _N_                                   | **none** — settled, so nothing is offered                             |
| `invited`                                             | `Mail` · **Invitation sent** · `--el-info`            | to `@login`, waiting to be accepted on GitHub                            | **Resend invitation** (+ **Open the invitation** on the per-repo row) |
| `not_invited`, identity present                       | `UserPlus` · **Not invited yet** · `--el-warning`     | `@login` is ready to be invited                                          | **Invite**                                                            |
| `not_invited`, no identity — **someone else looking** | `UserPlus` · **Not invited yet** · `--el-warning`     | _Name_ hasn't connected a GitHub account, + "Only _Name_ can connect it" | **none, deliberately** — not even a disabled control (Q3)             |
| `not_invited`, no identity — **the member themself**  | `UserPlus` · **Not invited yet** · `--el-warning`     | Motir doesn't know your GitHub account yet                               | **Connect GitHub** (grant 1 — identity only)                          |
| invite failed                                         | `TriangleAlert` · **Couldn't invite** · `--el-danger` | GitHub turned the invitation down on _repo_                              | **Try again**                                                         |
| not eligible (Q1)                                     | `ShieldOff` · **No code access** · `--el-icon-muted`  | Viewers can read _Project_ but not edit it                               | **Change role** → Access & members                                    |

**Rules that hold across all seven:**

- **An icon AND a word, never colour alone** — §5's rule, kept. Colour lives on the ICON; the word
  carries the meaning; the reason follows after a `·` separator in `--el-text-secondary`.
- **A failure never fails the person.** An invitation GitHub refuses leaves the repository row
  `created` and the repository real (MOTIR-1900's degrade-gracefully contract, and the reason
  `inviteAfterEstablish` swallows). So `Couldn't invite` is red on ONE line inside a row that is
  otherwise fine, and the header count counts what is TRUE (`4 of 5 can clone`) rather than what was
  attempted.
- **Not eligible is its own CARD, not a greyed row in the list.** Q1's exclusion is a statement about
  the project's roles, not a pending task — mixing it into the actionable list would read as "this
  one is stuck", which is the opposite of what it means.
- **`not_invited` uses `role="status"`** on the no-identity variant, inherited from §5 panel 4: it is
  the state that changes without the user acting on this page (they connect elsewhere and come back).

## 15.7 · The teammate's own view (panel 4) — the same table, one row different

`Connect GitHub` is offered **only on your own row**, and the pane leads with the shipped identity
card when you have no identity at all. Three things are load-bearing:

1. **It asks for grant 1 (identity) only.** `GithubIdentity.githubLogin` is the single thing Motir
   needs to invite somebody — the same field MOTIR-1900 reads. The repository-access install (grant 2)
   is NOT asked for here, because nothing on this surface reads a repository the member owns.
2. **A handle is never typed.** The account invited is the one CONNECTED, for the reason MOTIR-1900's
   own comment gives: a typed handle proves nothing, and a typo invites a **stranger** to a private
   repository.
3. **Every other row reads exactly as it does for an admin** — with a `Pill`-free `note` stating in
   words that inviting somebody, and changing who is eligible, is an admin's to do. The controls do
   not vanish and are not disabled-with-a-tooltip; they were never that member's to begin with.

After connecting, the row settles through the same two states as everyone else's (`Invitation sent`
→ `Has access`) and the header card is replaced by the shipped `IdentityHeader` line.

## 15.8 · Empty, loading, partial, refused (panel 5)

| State                                                | What it says                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A · no repositories yet**                          | `EmptyState` — _"Atlas has no code yet"_ + what will happen at plan approval + **Review the plan**. Not an error, and not an empty table.                                                                                                |
| **A′ · Motir hosts none, but the ORGANISATION does** | Same `EmptyState`, different sentence — _"Motir hasn't made any repositories for Atlas"_ + the count of connected repositories + who grants access to those + **See this project's repositories**. **AMENDED by MOTIR-4803**, see below. |
| **B · the set is mid-establish**                     | The count `Pill` becomes **Setting up** (`LoaderCircle`), a peach `alert` names the repository still being made, and the rows are skeletons. Says explicitly that leaving loses nothing (the ADR's resumability).                        |
| **C · a partial set**                                | `skipped` and `connected` rows are shown in the set strip but excluded from the count — the reason `needsCollaboratorInvite` gives in code. A partial set therefore needs NO special case.                                               |
| **D · GitHub refused**                               | A rose `alert` above the list states the scope of the failure (_1 of 3 invitations for Jonas Vik_), insists the repositories are fine, and offers **Try again**.                                                                         |

### AMENDMENT (bug MOTIR-4803, 2026-09-07) — state A needed SPLITTING, not widening

State A above says _"Atlas has no code yet"_, and that sentence quantifies over the PROJECT's code
while this pane is scoped to the repositories **Motir made**. The two came apart the moment a project
could hold repositories it did not get from Motir: on Motir's own project — six repositories connected
to the organisation, an empty `project_repository` set — the pane renders an empty state asserting the
project has no code at all. **A reader cannot tell a scoped page from a broken one**, which is the
report this bug arrived as, alongside the question _"what IS the difference between `Code access` and
`Repositories`?"_

**What is NOT amended: the READ.** §15's pane still lists the SET, and the page header's paragraph
(MOTIR-3126) still gives the reason — a connected repository has no collaborator invitation for Motir
to report, grant or revoke, so a row for one would be strictly worse than its absence. The list was
never the defect. **The sentence was wider than the list**, and the fix narrows the sentence rather
than widening the list.

So state A splits in two, on `resolveEffectiveRepoDomain(…).connected.length`:

- **A (unchanged)** — nothing anywhere. The plan-approval sentence and **Review the plan**.
- **A′** — Motir hosts none of it, the organisation holds N. It says what Motir has not done, how many
  repositories the project actually works on, who grants access to those (§15's own `partialNote`
  voice, verbatim: _"a repository the team already owns is reached through GitHub, not through
  Motir"_), and it points at the room that answers _which repositories_.

**Why A′ has a link out, when §17.4 forbids exactly that shape.** §17.4's rule is about an empty state
standing in for an ACT the room could perform — _"nothing to pick"_ signposting elsewhere turns one
intent into two errands. There is no act here and there cannot be: granting access to a repository
Motir does not host is not this room's to perform, by the decision above. So A′ is §17.5's shape
instead — an absence plus one sentence naming **who** can act and **where** — which is what turns an
absence into an answer rather than a bug report.

**No new primitive, no new panel, no new affordance type**: the same `EmptyState`, the same
`FolderGit2`, the same single secondary `<a>`-as-button. Only the three strings and the destination
differ (§15.15's table carries them as `empty.connected*`).

## 15.9 · Primitives — every element, and what it is

| Element                                         | Primitive                                                                | Notes                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The pane column                                 | the shipped settings page shell                                          | `mx-auto max-w-[42rem] flex flex-col gap-6`; `font-serif text-3xl font-semibold` title + `text-sm text-(--el-text-muted)` subtitle.         |
| **People** / **Not eligible** containers        | `Card` with `header`                                                     | Header = `h2 text-base font-semibold` + a count `Pill tone="neutral"`, control on the right — the shipped Members-card shape.               |
| Each person                                     | the shipped `ProjectMembersSettings` `<li>`                              | `flex gap-3 border-b border-(--el-border-soft) py-3 last:border-b-0`; `items-start` (not `items-center`) because the row grew a state line. |
| Initials disc                                   | the shipped disc                                                         | `size-8 rounded-full bg-(--el-text) text-(--el-text-inverted) text-xs font-semibold`, `aria-hidden`.                                        |
| The repository SET strip                        | `Pill tone="neutral"` + `font-mono`                                      | One chip per repository, with the octocat. The only place a repository is named at the top level.                                           |
| The state line                                  | icon + word, `--el-text-strong`                                          | **Never** a `Pill`: these rows sit on an untinted card, and §5 already fixed this vocabulary as icon + word.                                |
| Permission (`push` / `admin`)                   | `Pill tone="neutral"`                                                    | Per-invitee (Q2). On the row for the roll-up, on each per-repo line in the expansion.                                                       |
| Project role (`Admin`)                          | `Pill memberRole="admin"`                                                | Only where the role IS the answer (the approving user). The shipped role-chip hue map, unchanged.                                           |
| **Invite** / **Connect GitHub** / **Try again** | `Button variant="secondary" size="sm"`                                   | The row's trailing control. `Connect GitHub` carries the octocat, exactly as the shipped connect button does.                               |
| **Resend invitation** / **Change role**         | `Button variant="ghost" size="sm"`                                       | Quieter, because they are recoveries rather than the main move.                                                                             |
| The lead connect card (panel 4)                 | `Card` + the shipped `IdentityHeader` shape + `Button variant="primary"` | The one primary button on the surface — it is the one thing the signed-in member can do.                                                    |
| The per-repository expansion                    | a `--el-surface-soft` box at `--radius-card`                             | Not a nested Card: it is a detail OF the row, and a second card border inside a card reads as a second object.                              |
| Empty state                                     | `EmptyState`                                                             | Icon disc (`--el-card-icon-bg` / `--el-card-icon-fg`) + title + body + one secondary action.                                                |
| Mid-establish / refused banners                 | the shipped notice shapes                                                | `--el-warning-surface` (peach) for "still working", `--el-danger-surface` (rose) for "GitHub refused".                                      |
| The admin-only note (panel 4)                   | the `--el-notice-info-bg` callout                                        | Same shape the members pane uses for its read-only note.                                                                                    |

## 15.10 · Token roles — colour (`--el-*`) and shape

**Colour.** Every value is a palette token; nothing is a raw hue.

| Role                                         | Token                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Page ink · secondary · muted · faint         | `--el-text` · `--el-text-secondary` · `--el-text-muted` · `--el-text-faint`                                | — faint is correct here: this row inventories the ink SCALE; faint stays in it as the decorative rung. |
| The state WORD                               | `--el-text-strong`                                                                                         |
| `accepted` icon                              | `--el-success`                                                                                             |
| `invited` icon                               | `--el-info`                                                                                                |
| `not_invited` icon                           | `--el-warning`                                                                                             |
| invite-failed icon                           | `--el-danger`                                                                                              |
| not-eligible icon + word                     | `--el-icon-muted` + `--el-text-muted` (inactive, NOT a severity)                                           |
| Card surface · border · soft border          | `--el-card` · `--el-border` · `--el-border-soft`                                                           |
| The per-repo expansion fill                  | `--el-surface-soft`                                                                                        |
| Count / permission chips                     | `--el-chip-bg` + `--el-chip-border` + `--el-text-secondary`                                                |
| `Admin` role chip                            | `--el-role-admin` + `--el-text-strong`                                                                     |
| `Verified` badge                             | `--el-tint-mint` + `--el-text-strong` (the shipped `Pill severity="success"`)                              |
| Mid-establish banner · GitHub-refused banner | `--el-warning-surface` / `--el-warning-text` · `--el-danger-surface` / `--el-danger-surface-text`          |
| The admin-only note                          | `--el-notice-info-bg` + `--el-text-strong`                                                                 |
| Primary CTA (Connect GitHub, panel 4)        | `--el-accent` + `--el-accent-text`                                                                         |
| Rail: surface · border · active row          | `--el-sidebar-bg` · `--el-sidebar-border` · `--el-sidebar-item-bg-active`, active glyph `--el-icon-active` |
| Identity disc                                | `--el-avatar-fallback` + `--el-text-inverted`                                                              |
| Empty-state icon disc                        | `--el-card-icon-bg` + `--el-card-icon-fg`                                                                  |

**AA contrast (finding #35).** Every hued surface carries the hue in the BACKGROUND with
`--el-text-strong` ink; no state is signalled by colour alone anywhere — each carries an icon and a
word.

**Shape.** `--radius-card` (cards, the expansion box, banners, the empty state) · `--radius-btn` +
`--height-btn-sm` / `--height-btn-md` + `--spacing-btn-x` / `--spacing-btn-x-sm` (buttons) ·
`--radius-badge` + `--spacing-chip-x/y` (pills and repo chips) · `--radius-control` +
`--height-control` + `--spacing-control-x/y` (rail rows) · `--radius-input` + `--height-input`
(the combobox in the door-2 repro) · `--spacing-card-padding` (card padding) · `--shadow-elevated`
(the mock's panel frames only). No raw `rounded-*` / `p-*` / `h-*` anywhere.

## 15.11 · Copy — every string, as `en.json` keys

Namespace `settings.codeAccess.*` unless noted. MOTIR-1945 owns the entries; this is the spec.

### The doors

| Key                       | String                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| `settings.nav.codeAccess` | Code access                                                               |
| `doorCard.title`          | Code access                                                               |
| `doorCard.summary`        | {granted} of {eligible} people who can edit can clone this project's code |

### The room

| Key                  | String                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `title`              | Code access                                                                                                               |
| `subtitle`           | Who on **{projectName}** can clone and push to the repositories Motir made for it.                                        |
| `peopleHeading`      | People                                                                                                                    |
| `countPill`          | {granted} of {eligible} can clone                                                                                         |
| `refresh`            | Refresh                                                                                                                   |
| `setLabel`           | {count, plural, one {# repository} other {# repositories}}:                                                               |
| `notEligibleHeading` | Not eligible                                                                                                              |
| `notEligibleBody`    | Code access follows the project's own edit permission. Someone who can't edit {projectName} is never invited to its code. |
| `youSuffix`          | ` (you)` — reuses the shipped `settings.access.youSuffix`                                                                 |

### The states

| Key                         | String                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `state.accepted`            | Has access                                                                                             |
| `state.acceptedReason`      | **@{login}** can clone and push to all {count}                                                         |
| `state.acceptedReasonOne`   | **@{login}** can clone and push to **{repo}**                                                          |
| `state.invited`             | Invitation sent                                                                                        |
| `state.invitedReason`       | to **@{login}**, waiting to be accepted on GitHub                                                      |
| `state.notInvited`          | Not invited yet                                                                                        |
| `state.notInvitedReady`     | **@{login}** is ready to be invited                                                                    |
| `state.notInvitedOther`     | {name} hasn't connected a GitHub account                                                               |
| `state.notInvitedOtherNote` | Only {name} can connect it — Motir invites the account a person connects, never one typed in for them. |
| `state.notInvitedSelf`      | Motir doesn't know your GitHub account yet                                                             |
| `state.failed`              | Couldn't invite                                                                                        |
| `state.failedReason`        | GitHub turned the invitation down on **{repo}**                                                        |
| `state.ineligible`          | No code access                                                                                         |
| `state.ineligibleViewer`    | Viewers can read {projectName} but not edit it                                                         |
| `expand`                    | {count, plural, one {# repository} other {# repositories}}                                             |
| `expandPartial`             | {count, plural, one {# repository} other {# repositories}} · {sent} sent                               |

### The actions

| Key              | String                  |
| ---------------- | ----------------------- |
| `invite`         | Invite                  |
| `resend`         | Resend invitation       |
| `openInvitation` | Open the invitation     |
| `retry`          | Try again               |
| `connect`        | Connect GitHub          |
| `changeRole`     | Change role             |
| `useDifferent`   | Use a different account |

### The member's own header + the read-only note

| Key                    | String                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `self.title`           | You aren't connected to GitHub yet                                                                                                         |
| `self.body`            | {projectName}'s code is private. Connect GitHub and Motir invites you to {count, plural, one {the repository} other {all # repositories}}. |
| `self.identityCaption` | The GitHub account Motir invites to this project's code                                                                                    |
| `self.verified`        | Verified                                                                                                                                   |
| `readOnlyNote`         | You can see where everyone stands. Inviting somebody, and changing who's eligible, is a project admin's to do.                             |

### Empty, loading, partial, refused

| Key                     | String                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty.title`           | {projectName} has no code yet                                                                                                                                                                                                                                    |
| `empty.body`            | When a plan is approved, Motir creates this project's repositories — and everyone who can edit {projectName} gets invited to them. There is nothing to grant until then.                                                                                         |
| `empty.action`          | Review the plan                                                                                                                                                                                                                                                  |
| `empty.connectedTitle`  | Motir hasn't made any repositories for {projectName}                                                                                                                                                                                                             |
| `empty.connectedBody`   | This page counts only the repositories Motir made. {projectName} works on {count, plural, one {one repository} other {# repositories}} connected to your organisation instead — a repository the team already owns is reached through GitHub, not through Motir. |
| `empty.connectedAction` | See this project's repositories                                                                                                                                                                                                                                  |
| `establishing.pill`     | Setting up                                                                                                                                                                                                                                                       |
| `establishing.banner`   | Motir is still creating **{repo}**. Invitations go out as each repository lands — nothing here is lost if you leave.                                                                                                                                             |
| `partialNote`           | Only the repositories Motir made are counted. A repository the team already owns is reached through GitHub, not through Motir.                                                                                                                                   |
| `failedBanner`          | GitHub wouldn't take {failed} of {total} invitations for **{name}**. The repositories are fine — only the invitation failed, and it can be sent again.                                                                                                           |

### Accessible names — the superstring audit

Each per-row control's accessible name carries the member, so `getByRole('button', { name: 'Invite' })`
can never match two rows — and no name is a superstring of another (the `e2e-selector-contract`
lesson):

| Control                  | Accessible name                         |
| ------------------------ | --------------------------------------- |
| Invite                   | `Invite {name}`                         |
| Resend invitation        | `Resend invitation for {name}`          |
| Try again                | `Retry invitation for {name}`           |
| Connect GitHub (own row) | `Connect GitHub`                        |
| Change role              | `Change {name}'s project role`          |
| The expander             | `Show per-repository access for {name}` |
| Refresh                  | `Refresh access from GitHub`            |

## 15.12 · a11y

- The people list is a `<ul role="list">` of `<li>`; the initials disc is `aria-hidden` and the name
  is the row's text (mirrors the shipped members list).
- **The expander is a `<button aria-expanded>`** controlling the per-repository region by
  `aria-controls`; the chevron rotates and is `aria-hidden`. Never a click handler on a `<div>`.
- **`role="status"`** on the `not_invited` line, so a member who connects in another tab and returns
  hears the change (inherited from §5 panel 4).
- **The refused banner is `role="alert"`**; the mid-establish banner is `role="status"` (it resolves
  on its own and must not interrupt).
- Every state carries an **icon and a word** — colour is never the only cue, so the whole surface is
  legible in greyscale and to a colour-blind reader.
- **No disabled control anywhere.** Q3's "you can't act on this" is expressed by the control being
  ABSENT plus a sentence saying why — a disabled button with a tooltip would promise an action that
  is not merely unavailable but not theirs.
- The rail row is a link with `aria-current="page"` when active — the shipped `Sidebar` behaviour, no
  change.

## 15.13 · Page state after this surface's mutations (the enforced contract)

Three mutations, and each names the surfaces it touches (`motir-core/CLAUDE.md`'s three-mechanism
rule):

1. **Invite / Resend / Retry (one member).** Touches (a) that member's row and its per-repository
   detail, (b) the header **count** `Pill`, (c) the **door-2 card's count** on the Access & members
   pane. (a) is the acting row — keep the optimistic value, the response IS the confirmation, no
   refresh of that cell. (b) is server-rendered on this page → `router.refresh()`. (c) is on ANOTHER
   route, so it re-reads on next navigation; there is nothing to bump.
2. **Refresh (the whole set).** `refreshAccess` re-reads GitHub for every pending invitation and
   stamps the accepted ones. It returns the rows, so the list updates from the RESPONSE, and
   `router.refresh()` follows for the count. It is an explicit button rather than a poll for the
   reason `projectRepoAccessService.refreshAccess` documents: GitHub owns acceptance and tells Motir
   nothing when it happens.
3. **Connect GitHub (the member's own).** Leaves the app and returns via OAuth, so the page REMOUNTS
   — no client-island tick is needed. On return, the lead card is gone and the member's own row shows
   the identity; if the invite pass ran on callback it may already read `Invitation sent`.

**If the people list is built as a client island** seeded from `useState(initialRows)` — which it
should be, since it owns optimistic per-row pending state — then `router.refresh()` CANNOT reach it,
and each mutation must reconcile the island from its own response (seq-guarded per row, the shipped
`fetchSeq` pattern). This is the exact 6.11.7 shape the contract exists to prevent.

## 15.14 · Explicitly OUT of scope here

- **The mechanism** — MOTIR-1910: the per-`(repository × user)` record, the `canEdit` +
  assignable-members enumeration, the permission column and the owner's `admin` backfill, the invite
  and refresh endpoints, the DTO. Its states are drawn; none of its schema is designed here.
- **The five answered questions** — MOTIR-1943. Cited, never re-decided.
- **The GitHub connect / install screens** — 7.10. Only the hand-off is drawn, as the shipped
  components.
- **The establish step and the take-it-over flow** — §0–§14 above. Their vocabulary is composed; not
  one of their panels is changed.
- **CI spend** — MOTIR-1901 / MOTIR-1907. Q5 decided no new guard, so nothing here meters, warns or
  refuses.
- **Changing a project role** — the shipped Access & members pane. `Change role` is a link to it, not
  a control this surface owns.
- **Removing someone's code access** — deliberately not drawn. MOTIR-1943 decides who is invited, not
  how a grant is revoked, and `projectRepoAccessService` has no revoke path; a control the service
  cannot honour would be a worse promise than none. When a revoke lands it belongs on this row.
- **Org-wide or cross-project access** — `ProjectRepo` is project-scoped and so is this pane.

---

# 16. `repositories-room.mock.html` — THE ROOM RENDERS BOTH REGISTRIES

**Story MOTIR-1775 · bug MOTIR-3126.** The design reference for what
`/settings/project/repositories` shows when a project's repositories do **not** all live in
`project_repository`: the Motir-hosted set and the workspace-connected repositories, drawn as **two
sections**, with the empty state reserved for the one project shape it is true of.

- **Asset of record:** [`repositories-room.mock.html`](./repositories-room.mock.html); `.png` export
  [`repositories-room.png`](./repositories-room.png) (full-page, light theme, `deviceScaleFactor: 2`,
  width 1200).
- **Scope:** pixels and copy. The layering itself is already decided and already shipped — see §16.2.

## 16.1 · The answer in one line

**The room renders the repository DOMAIN, not one table** — and it renders it as two named sections,
because a Motir-hosted row can be taken over and a workspace-connected repository cannot. A section
whose registry contributes nothing is **absent**, never present-and-empty-stated; the empty state
belongs to a project with neither.

## 16.2 · What was already decided, and by whom — this asset decides ONE thing

Nothing below is a new answer to _"which repositories does this project have?"_. That was decided by
`docs/decisions/project-repository-set.md`'s **2026-08-19 amendment** (MOTIR-3086) and implemented as
a layered ladder in `lib/workItems/dispatchRepo.ts`:

| Project shape                        | The domain                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| no set                               | the workspace's connected repositories                                                                |
| a set, project born in Motir         | the set alone                                                                                         |
| a set, project **arrived with code** | the set FIRST, the connected repositories under it (`mergeDomainsByName`, deduped by lowercased name) |

The predicate for the third rung is `projectHasItsOwnCode` (`lib/projectRepos/ownCode.ts`) — the
project's `migrate_onboarding` run names a connected repository.

**The one decision this asset makes: TWO SECTIONS, not one merged list.** The resolver merges the two
registries because dispatch only needs a set of names. A person needs to tell them apart: the room
exists so a Motir-hosted repository can be MOVED (§14 · MOTIR-1939), and a repository the user already
owns has no such action. One merged list would offer a meaningless action on half its rows, and the
alternative — offering it on none — would remove the room's whole purpose. Two sections keeps each
half's provenance legible and each half's affordances honest.

**A taken-over row stays in the HOSTED section**, reading `Yours`. It is a `project_repository` row
and the saga's history lives on it. The sections answer _"which registry is this row in"_; ownership
is the row's own state word, where §14.7 already put it.

### AMENDMENT (bug MOTIR-4867, 2026-09-08) — a repository MOTIR HOSTS is in NEITHER section

The sentence above says the sections answer _"which registry is this row in"_, and that is still the
rule. What MOTIR-4867 found is that the room could not answer it, because the registry it reads
cannot say **whose** a repository is.

`From your organisation`'s layered half comes from `githubRepoRepository.listByWorkspace`, which
filters on `github_repo.workspace_id` and nothing else. That read answers _"can this workspace
dispatch into it?"_ — deliberately, because MOTIR-1931 needed a repository Motir CREATES for a
workspace to be a legal `targetRepo`, and `persistProvisionedRepo` writes the creating project's
`workspace_id` onto exactly such a row. So a repository under the **provisioning organisation** that
the current project holds no `project_repository` row for survived the de-duplication and was drawn
under a heading reading _"Repositories moooon is connected to"_, counted in `yours`, and absent from
`0 hosted by Motir`. On the MOTIR project that was one row, and it was the only row on the page with
an action available — the takeover this whole area exists for — drawn as the rows that have none.

**It is subtracted from the org section and counted in neither total.** Three reasons, in the order
they decided it:

1. **The hosted section draws ROWS.** Its hint promises _"Motir created these and pays for their CI.
   Move any of them to your own GitHub whenever you want."_ A mirror row with no `project_repository`
   row has no takeover to offer, so putting it there would print that promise above the one
   affordance it cannot keep — the §16.6 rule ("a control that cannot keep its promise is worse than
   its absence") one tier up, applied to a whole row.
2. **The room already answers for it, elsewhere.** `otherHostedProjects` (§14.4) is the drawn pointer
   to the sibling projects whose code Motir also hosts. A hosted repository this project holds no
   link to is that pointer's business.
3. **It makes the room's two renders agree.** The client island rebuilds this list from
   `connectCandidates`, which comes from `listOrganizationInstallations` — and the shared
   provisioning installation names no organisation, so it was never in that list. The row was present
   on the server render and gone after the first mutation. Both renders now settle on the
   organisation-scoped answer, which is also what `get_project_state` reports.

**`0 hosted by Motir` on a set-less project is therefore TRUE**, not an omission: the count is of what
that section draws, and it draws this project's own rows.

The classification WAS a helper in `lib/projectRepos/roomSections.ts`, keyed on
`ProjectRepoRoomViewDto.hostOwner` — carried on the view since MOTIR-1939 and, until this bug, read
by nothing but the onboarding step. **It was passed in, never read from the environment**, because
the module is pure and client-safe on purpose; `hostOwner: null` (a deployment with no
`GITHUB_FALLBACK_ORG`, which hosts nothing) classified nothing and left the room exactly as it was.
**And the fix is a classification, never a narrower read** — filtering inside `listByWorkspace` would
un-dispatch every hosted repository to correct a settings page.

> ⚠️ **SUPERSEDED (MOTIR-4954 · MOTIR-4955 · MOTIR-4998), and the paragraph above is kept as the
> record of WHY the rule exists rather than as a pointer to live code.** The room no longer draws the
> layered list at all, so it no longer makes this classification: MOTIR-4955 retired the workspace
> rung and MOTIR-4998 deleted the helper once its last caller went. **The RULE is untouched** — a
> repository Motir hosts is not the organisation's — and the predicate is still one predicate,
> `isMotirHostedOwner` (`lib/git/hostOwnership.ts`, MOTIR-4892). Its live askers are now the
> organisation inventory (`lib/mappers/organizationRepoMappers.ts`) and the CI meter's §5.1 gate
> (`lib/ciMetering/config.ts`), and `tests/projectRepos/hostOwnershipAgreement.test.ts` pins those
> two against each other.

## 16.3 · Drawn against SHIPPED reality — what was RENDERED first

Both halves ship, so both were rendered before anything was drawn (the design-against-shipped-reality
rule; `notes.html` #73):

- **The room's island** — `RepositoriesRoom` + `TakeoverRow` — bundled from its own source with the
  real compiled `globals.css` and screenshotted in both branches. Its empty branch is what panel 1
  reproduces on the left, verbatim: one `EmptyState` card, the false sentence, **nothing pressable**.
- **The connected-repository list** — the shipped one from
  `app/(authed)/settings/workspace/github/page.tsx` (lines 289–307): a `Card` over a
  `flex flex-col gap-1` list whose every row is a `FolderGit2` glyph, an `owner/` + `name` pair, and a
  mono default-branch chip. Mirrored element for element rather than restyled, so the two surfaces
  that render the same fact render it the same way.
- **The token, primitive and icon layers** are the ones `takeover.mock.html` generated from
  `@motir/design-system/theme.css` and `lucide-react`. Reused verbatim, so this area's two room assets
  cannot drift apart.

## 16.4 · Placement and the access path

**Unchanged from §14.4** — the room already has three doors (the approval step's ownership promise,
the billing panel's `Move repositories`, and the permanent project-settings rail row) and this asset
adds none. Panel 2 draws the rail with `Repositories` active, which is the door that is always there.
What changes is only what the room renders once you are in it.

## 16.5 · The panels

| Panel                                    | Project shape             | What it draws                                                                                        |
| ---------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Ladder table**                         | all four                  | Which registry answers, and which section the room renders — the resolver's answer, not the asset's. |
| **1 · Arrived with code, empty set**     | MOTIR today               | The shipped defect on the left, the target on the right: the connected section, named and sourced.   |
| **2 · Arrived with code, non-empty set** | both registries           | The WHOLE page in the settings shell — rail, header, summary, hosted section, then yours.            |
| **3 · Born in Motir**                    | the set alone             | One section. The yours heading is **absent**, not empty — including with a taken-over row present.   |
| **4 · Genuinely empty**                  | no set, nothing connected | The rewritten empty state, with the action it never had.                                             |

### Why the empty state needed rewriting, and not just re-gating

`repositoryTakeover.empty` said _"Motir sets them up when you approve a plan"_ — one of the two ways a
project gets repositories, stated as if it were both. Gating it correctly would have left it true and
still incomplete on the surface it is the only sentence on. It now names both routes and offers the one
the reader can take right now.

## 16.6 · Primitives — every element, and what it is

| Element                   | Primitive                                          | Notes                                                                                   |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Section heading           | `SectionLabel`                                     | The mono/uppercase/`--el-text-eyebrow` caption. One per registry.                       |
| Section hint              | `<p>` at `--el-text-secondary`                     | One sentence of provenance, ≤ 68ch.                                                     |
| Motir-hosted row          | **the shipped `TakeoverRow`**                      | Untouched — §14.6's row, its tints, its states and its `RowActions` strip.              |
| Connected-repository list | **the shipped workspace-GitHub list, in a `Card`** | `FolderGit2` + `owner/`+`name` + branch chip. No action of any kind on a row.           |
| The list's footer         | `Card` footer row                                  | Provenance sentence + the one link, to `/settings/workspace/github`.                    |
| The empty state           | `EmptyState` + a `Button variant="secondary"`      | Icon `FolderGit2` (the sibling code-access room's choice), not the default `Inbox`.     |
| Header summary            | the shipped `summary` line                         | `{moving} moving · {hosted} hosted by Motir · {yours} yours`, counted over BOTH halves. |
| Settings rail + pane      | the shipped settings AREA shell                    | `PROJECT_SETTINGS_NAV` groups. Redrawn nowhere.                                         |

**No new affordance is introduced anywhere on this surface.** The only pressable things added are one
link (to a shipped pane) and one button in the empty state (to the same pane).

## 16.7 · Token roles — colour (`--el-*`) and shape

The hosted rows keep §14.7's three registers exactly. The connected list is deliberately **untinted**:
a register is what a row's STATE is drawn in, and a connected repository has no state in this room — it
is a fact, not a step. Tinting it would put it in a conversation about ownership it is not part of.

| Element                          | Colour role                                                                                                      | Shape role                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Connected list container         | `--el-card` + `--el-border`                                                                                      | `--radius-card` · `--spacing-card-padding`   |
| Connected list row               | none (transparent)                                                                                               | `--radius-control` · `--spacing-control-x/y` |
| Repository glyph                 | `--el-icon-muted`                                                                                                | —                                            |
| `owner/` prefix                  | `--el-text-muted` — AA-safe here and ONLY here (4.54:1 on the white card; it fails on all three tinted surfaces) | —                                            |
| Repository name                  | `--el-text`, `font-medium`                                                                                       | —                                            |
| Default-branch chip              | `--el-code-bg` / `--el-code-text`                                                                                | `--radius-control` · `--spacing-chip-x/y`    |
| Section heading                  | `--el-text-eyebrow`                                                                                              | —                                            |
| Section hint · list footer       | `--el-text-secondary`                                                                                            | —                                            |
| Footer link                      | `--el-link` → `--el-link-pressed`                                                                                | —                                            |
| Empty-state glyph · title · copy | `--el-icon-muted` · `--el-text` · `--el-text-subtitle`                                                           | `--radius-card` · `--spacing-card-padding`   |

## 16.8 · Copy — every string, as `en.json` keys

Namespace **`repositoryTakeover`**. ⚠️ **Every key below needs a matching `zh.json` key** or the
i18n-catalog parity gate fails the PR.

| Key                     | English                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leadConnected`         | Where {projectName}'s code lives — the repositories Motir hosts for you, and the ones you connected yourself.                                         |
| `hostedHeading`         | Hosted by Motir                                                                                                                                       |
| `hostedHint`            | Motir created these and pays for their CI. Move any of them to your own GitHub whenever you want.                                                     |
| `yoursHeading`          | Your own repositories                                                                                                                                 |
| `yoursHint`             | Connected to this workspace through the Motir GitHub app. They're already yours — nothing to move, and Motir never bills their CI.                    |
| `yoursFoot`             | Connected for the whole workspace, not for this project alone.                                                                                        |
| `yoursManage`           | Choose which repositories Motir can see                                                                                                               |
| `empty` **(rewritten)** | No repositories are connected to this project yet. Connect the code you already have on GitHub, or approve a plan and Motir will create them for you. |
| `emptyAction`           | Connect a repository                                                                                                                                  |

`lead` (the existing header sentence) is kept for a project that HAS hosted repositories, because it is
about them; `leadConnected` replaces it when the hosted section is absent, where the old sentence
describes something the reader cannot see. `summary` is unchanged as a STRING and changes only in what
feeds it: a workspace-connected repository counts toward `yours`.

### AMENDMENT (bug MOTIR-4820, 2026-09-07) — the four `yours*` keys are RETIRED

**§17.2 renames this section and §17 draws it as one section; the four keys above belonged to the
section it renamed, and they are gone from `en.json` / `zh.json`.** They are struck rather than
deleted from this table because a reader meeting an old citation should land on the reason:

| Key                | What replaced it                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`yoursHeading`~~ | `repositoryPicker.section.heading` — **From your organisation** (§17.2)                                                                                                                                                      |
| ~~`yoursHint`~~    | `repositoryPicker.section.hint`                                                                                                                                                                                              |
| ~~`yoursFoot`~~    | `repositoryPicker.section.provenance` — the same sentence, RE-TIERED: _"Connected to the organisation, not to this project alone."_ It said **workspace**, which stopped being the tier that owns a repository at MOTIR-4649 |
| ~~`yoursManage`~~  | `repositoryPicker.section.seeAll` — the footer link stopped being a hand-off and became a view (§17.2)                                                                                                                       |

**`yoursDetail` is NOT one of them and stays.** It is the already-yours row's reassurance inside
`TakeoverRow` (§14.7), which this card does not touch — the four retired keys are the SECTION's, and
that one is a ROW's.

**What made them dead is the shape, not the copy.** MOTIR-4681 shipped §17.2's rename as a SECOND
section keyed on `project_repository.seedSource` and left the old one standing beside it, so a project
with no repository SET drew an EMPTY `From your organisation` directly above the same repositories
under `Your own repositories` — while `/settings/organization/git`, moved onto the ladder by
MOTIR-4802, read `Used by <project>` for every one of them. The section is now the LADDER's answer, so
the two surfaces agree by construction and there is one section, as Panel 5 draws it.

## 16.9 · a11y

- Each section is a `<section aria-labelledby>` pointing at its `SectionLabel`, so the two lists are
  distinguishable to a screen reader by name and not by order alone. That is the whole a11y content of
  the two-section decision.
- The connected repositories are a real `<ul>` / `<li>`, so the count is announced. Nothing in a row is
  focusable — there is no action, and a focus stop that leads nowhere is worse than none.
- The branch chip is plain text beside the name, inside the same list item, so it is read as part of
  the row rather than as an unlabelled control.
- The empty state's action is a `<a>` styled as a button (it navigates), not a `<button>`.

## 16.10 · Page state after a mutation (the enforced contract)

The only mutation on this surface is still the takeover, and §14.10 governs it unchanged. The one thing
this asset adds:

**The connected section is fed by the SAME server read as the rows and refreshed by the same island
refetch.** The rows are a client island seeded from server props, so `router.refresh()` cannot reach
them (contract surface 3) — and a connected section that only `router.refresh()` reached would go stale
against the very list it sits beside. It therefore rides the island's own refetch, which already runs
after every mutation and on the takeover poll.

**Whether the section is rendered at all is decided on the SERVER**, from the ladder, and is not
re-derived on the client. The client re-reads the LIST; it never re-decides whether the list belongs on
this project — that is the one definition this whole card exists to stop duplicating.

## 16.11 · Explicitly OUT of scope here

- **The ladder itself** — MOTIR-3086 decided it and it is correct. This asset renders it.
- **Connecting a repository** — a workspace-level act at `/settings/workspace/github`. The room links
  there and grows no connect flow of its own.
- **The takeover flow** — §14, unchanged: not one of its panels, states or strings moves.
- **The plan-approval establish step** — §0–§13, and `RepositorySetStep`, which already consumes the
  connected candidates correctly.
- **Promoting a connected repository into `project_repository`** — the ADR amendment's own "what this
  does NOT fix". Until something does, a connected repository has no row, so it has no takeover, no
  role chip and no position; that absence is drawn rather than papered over.

---

# 17. `repositories-room.mock.html` §5–§9 — THE ROOM GAINS ITS DOOR

**Story MOTIR-4669 · subtask MOTIR-4674 (design amendment), 2026-09-05.** §16 drew the room
_rendering_ two registries. It could not _change_ either: connecting was a workspace-level act
somewhere else, and §16.11 says so in as many words — _"the room links there and grows no connect
flow of its own."_

**That is what this amendment inverts, and it is not a change of mind about §16 — it is a change in
what the model underneath it allows.** A repository is now connected **ONCE, to the ORGANISATION**,
and which projects use it is visibility configuration (MOTIR-2029's rule for the code graph, applied
to the thing the graph is built FROM). So the act a project performs is **ADD**, it happens **here**,
and it is **one action with two segments**.

- **Panels added:** 5 (the room with its door), 6 (the picker), 7 (a first-time organisation),
  8 (the non-org-admin arm), 9 (the project-side removal).
- **Nothing in Panels 1–4 is redrawn.** The ladder they render is unchanged; what changes is that
  the room can now act on it.
- **⚠️ NOT drawn here, and cited rather than redrawn:** the ORGANISATION's repository inventory,
  its index-state column, its `Used by N projects` column and its `Disconnect from organisation`
  dialog — `design/github/` and `design/gitlab/` Panels 6–7 (**MOTIR-4672**). This asset owns the
  PROJECT's side of the same model, and only that.

## 17.1 · The answer in one line

**The picker belongs to the room that already exists**, and it offers one list with two segments:
what the organisation already has, and connecting something new. **Three revisions of a sibling
design drew it somewhere else and each was rejected; the defect record is MOTIR-4668.** The room has
four assets and a header that says it renders the project's whole repository domain — a feature
drawing its own version of that room produces two designs of one surface that drift.

## 17.2 · Panel 5 — the door

- **`Add repository`, a `Button variant="primary"`, in the pane head beside the title.** It is the
  room's only add path, and it opens the same picker the organisation's Git settings opens — same
  flow, same picker, two doors.
- **The section heading changes from `Your own repositories` to `From your organisation`**, and its
  hint with it. The old copy was true of a workspace-connected repository and is false of an
  org-owned one: the repositories in this section are not the reader's personally, they are the
  organisation's, and the project has them because somebody added them.
- **The footer's link stops being a hand-off and becomes a view.** It read
  _"Choose which repositories Motir can see"_ — the way to perform an act this room could not. The
  room performs it now, so the link reads **"See every repository in moooon"** and points at the
  organisation's inventory (`design/github/` Panel 6). **That single change is the tier move in one
  line.**
- **The connected row gains ONE action** — `Remove from this project` — which is the first
  affordance a row in this section has ever carried. §16.6 said _"No action of any kind on a row"_
  and gave the reason: the user already owns these, so there was nothing to do. There is now: a
  project's link to an org repository is exactly the thing a project may change.

## 17.3 · Panel 6 — the picker: ONE list, TWO segments

| segment                           | what it offers                                                       | what it costs                                                                |
| --------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **In moooon · already connected** | the organisation's repositories, pick → linked immediately           | **nothing.** The row reads **`already indexed · shared`**, and no index runs |
| **Connect a new one**             | performs the organisation connection AND the project link in one act | the only path that costs an index                                            |

- **⚠️ `already indexed · shared` is a STATE, and it carries the whole promise of the tier move.**
  It says the code graph for this repository exists, belongs to the organisation, and is not rebuilt
  because a second project picked it up. Without it the row is indistinguishable from the segment
  below — which is exactly the pair the reader is being asked to tell apart. It is a **neutral
  chip**, not a tint: a fact about the repository, not a step in a flow.
- **A repository this project already has is LISTED and unpickable** (`already in this project`, at
  the shipped disabled opacity), rather than filtered out. A reader who came looking for it should
  find it and see why it is not offered.
- **⚠️ The provider asymmetry is drawn, not smoothed.** _Connect a new one_ is a **link-out** to the
  App's install screen for GitHub and an **in-app browse** for GitLab — the same honest inverse
  `design/gitlab/` §2b already draws. A picker that drew only the in-app arm would leave the
  commoner path improvised at build time.

## 17.4 · Panel 7 — a first-time organisation is a PICKER, not a signpost

**An empty-state panel with a link out is the exact shape this amendment exists to forbid.**
_"Nothing to pick"_ must never render as a message whose job is to send somebody to another page:
that turns one intent into two errands, which is the same defect at the project tier that the whole
story removes at the organisation tier.

So the zero case is the same picker with **one segment**. The search field is gone, because there is
nothing to search; the lead sentence says what will happen (_"connect the first one and it lands in
Acme booking at the same time"_); everything else is where it was. **The organisation connection
happens BECAUSE you added a repository — never as an errand you run first.**

## 17.5 · Panel 8 — the org-admin gate, drawn in both arms

**The room stays visible on `repository:manage`. Every ADD path inside it asserts ORG ADMIN.** That
is the story's own rule and it is what stops a project admin connecting a repository to the
organisation through a project-scoped permission.

**What a project admin who is not an org admin sees: the set, and no add affordance — plus one
sentence.** Not a disabled button, and not a silent absence either:

- **Not disabled.** A disabled control is a promise the product then refuses; the rail already makes
  that call for a whole area (MOTIR-2468 — _an entry point is a promise about a room_).
- **Not silent.** A room whose one action simply vanishes leaves a reader wondering whether they are
  looking at a bug. The section's footer says **who** can do it and **where**, which is what turns an
  absence into an answer.

**The project-side REMOVE is NOT gated on org admin**, and the discriminator is what the act
changes: removing a repository from this project deletes one `ProjectRepo` row and touches neither
the organisation's connection nor the code graph. It is the room's own scope, so it takes the room's
own permission, `repository:manage`.

## 17.6 · Panel 9 — the project-side removal REASSURES

**The two removals share a word and not a blast radius, so they must not share a weight.**

|                                    | **Remove from this project** (here) | **Disconnect from organisation** (`design/github/` + `design/gitlab/` Panel 7) |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| what it changes                    | one `ProjectRepo` row               | every project's link in the organisation                                       |
| the code graph                     | **nothing**                         | offboarded — `repo_disconnected`, windowed 30 days                             |
| the affordance                     | a quiet row action                  | a destructive confirm (GitLab) / a pre-link-out disclosure (GitHub)            |
| the confirm's primary              | `Remove`, a **secondary** button    | `Disconnect`, a **danger fill** / `Continue on GitHub ↗`                       |
| what the copy spends its length on | what does **not** happen            | what **does**                                                                  |
| who may do it                      | `repository:manage`                 | org admin                                                                      |

**⚠️ A project-level remove enqueues NO offboarding.** It deletes one row and nothing else — no new
member on `CodeGraphOffboardReason`. Saying so explicitly, on the surface and in these notes, is what
stops somebody adding one.

**Each LABEL names its own tier** (`Remove from this project` · `Disconnect from organisation`), so
neither depends on the reader knowing which page they are standing on.

## 17.7 · Primitives — every element, and what it is

| Element                    | Primitive                                 | Notes                                                                                                                                                                       |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Add repository`           | `Button variant="primary"` + `Plus` glyph | In the pane head's right slot. No new affordance type.                                                                                                                      |
| The picker                 | `Modal` + the shipped `Combobox` grammar  | Search input, grouped listbox, option rows — the same pattern `design/repository-set/` already composes for the takeover picker and `design/github/` §5b for pull requests. |
| Segment headings           | the listbox's own `grp` caption           | Two, and only two.                                                                                                                                                          |
| `already indexed · shared` | a neutral chip                            | `Pill` tone=neutral's treatment; no new tone, no new token.                                                                                                                 |
| `Remove from this project` | a quiet text button                       | The `QuietAction` treatment `RepositoryRow` already ships, in danger ink.                                                                                                   |
| The remove confirm         | `Modal` + `Button variant="secondary"`    | **Secondary, deliberately** — a danger fill would claim a blast radius this act does not have.                                                                              |
| Everything in Panels 1–4   | unchanged                                 | Not one of their panels, rows or strings moves.                                                                                                                             |

## 17.8 · Token roles added by this amendment

| Element                                       | Colour role                                                                          | Shape role                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `Add repository`                              | fill `--el-accent` · ink `--el-accent-text`                                          | `--radius-btn` · `--height-btn-md` · `--spacing-btn-x/y`       |
| Picker modal                                  | `--el-card` / `--el-border` / `--shadow-modal`                                       | `--radius-modal` · `--spacing-card-padding`                    |
| Search field                                  | `--el-page-bg` / `--el-input-border`                                                 | `--radius-input` · `--height-input` · `--spacing-input-x`      |
| Listbox / option / active option              | `--el-card` + `--shadow-elevated`; active `--el-option-active-bg`                    | `--radius-card` / `--radius-control` · `--spacing-control-x/y` |
| Segment heading                               | **`--el-text-eyebrow`** — ⚠️ see below                                               | —                                                              |
| Option repo name · owner prefix               | `--el-text` · `--el-text-secondary`                                                  | —                                                              |
| `already indexed · shared` chip               | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`, glyph `--el-icon-muted` | `--radius-badge` · `--spacing-chip-x/y`                        |
| Option sub-label (`opens GitHub`, `in Motir`) | **`--el-text-secondary`** — ⚠️ see below                                             | —                                                              |
| Already-in-this-project row                   | the shipped disabled treatment (`opacity`)                                           | —                                                              |
| `Remove from this project`                    | **`--el-danger-on-surface`**                                                         | —                                                              |
| Remove confirm's primary                      | the secondary button: text `--el-text` · border `--el-button-border`                 | `--radius-btn` · `--height-btn-sm`                             |

**⚠️ Two carried-over rules were corrected rather than used as they stood.** `.listbox .grp` was
`--el-text-faint` and `.listbox .opt .sub` was `--el-text-muted`, both inherited from
`takeover.mock.html` and **never exercised in this asset** — the picker is their first use. Faint
clears AA on **no** surface at all, and muted is 4.12:1 on `--el-option-active-bg`, which is what an
ACTIVE option paints. The segment headings are the information the whole panel turns on, so they are
not decoration; they take `--el-text-eyebrow`, and the sub-labels take `--el-text-secondary`.

**⚠️ And the removal's ink is `--el-danger-on-surface`, never `--el-danger-text`.** That token is the
ink FOR a danger FILL and is legal only on an element carrying `bg-(--el-danger)`; painted on a page
it measures 1.00–1.04:1 in every light palette. Raw `--el-danger` is not the answer either — it is
4.11–4.25:1 on the dark page in three palettes. This mock's own token block did not declare
`--el-danger-on-surface`, so this amendment adds it, verbatim from
`packages/design-system/theme.css`.

## 17.9 · Explicitly OUT of scope here

- **The organisation's inventory, its index column, `Used by N projects` and its disconnect
  dialog** — `design/github/` + `design/gitlab/` Panels 6–7 (**MOTIR-4672**). Cited, never redrawn.
- **The org settings rail row** that reaches that page — **MOTIR-4673**, `design/org-admin/`.
- **The member's own git credential** — **MOTIR-4675**, `design/settings/`.
- **The takeover flow and the establish step** — §0–§14, unchanged: not one of their panels, states
  or strings moves.
- **What happens to a `project_repository` row when a repository is added this way.** A picked
  repository is a link, not a hosted row; §16.11's _"promoting a connected repository into
  `project_repository`"_ remains unfixed and unfixed by this too.

---

# 18. `repositories-room--hosted-runs.mock.html` — WHERE MOTIR'S APP CAN WRITE (MOTIR-6518)

**This is the third draft and supersedes both earlier ones** — `cmuiszohk00nahvoiin43xjr5` (a second
GitHub App and a second account link) and `cmuivq6rw008ahvoiofyixyym` (one App, but pull requests
authored as the dispatcher, with an identity reconnect state). The review refused the second: _"hosted
run should commit as the app, not a person account. A non-tech user won't even have a github
account."_ `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` records the replacement: **a hosted
run writes as Motir's GitHub App, never as a person**, over the run's whole repository set. Do not
build from either earlier draft.

**A DELTA on §16–§17** (`repositories-room.mock.html`, MOTIR-4674 as MOTIR-4954 reshaped it). The
new mock, [`repositories-room--hosted-runs.mock.html`](repositories-room--hosted-runs.mock.html),
holds only the changed panels. **Nothing is drawn on Settings → Account → Git**: a person's GitHub
link plays no part in a hosted run, and that page's _"grants no access to any code"_ copy stays true.

## 18.1 · Panel 1 — one line per connected repository

**Where it lives:** Project settings → Repositories, **From your organisation**, as a line under each
connected repository's row.

The **Hosted by Motir** section is the shipped one and gets **no line**: Motir writes there with
`motir-studio`, so there is nothing to accept or reconnect.

| State                                                                                                                     | Line                                                                | Control                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **ready** — the repository's Motir Integration installation covers it and has accepted `contents` + `pull_requests` write | quiet: check icon + ready copy                                      | none                                                                                                            |
| **needs updated permissions** — the installation has not accepted write                                                   | warning line, names the account and that **an owner of it** accepts | **Review permissions on GitHub** → `githubInstallationManageUrl({ accountLogin, accountType, installationId })` |
| **can no longer reach** — the installation is gone or suspended, or no longer includes the repository                     | warning line                                                        | **Reconnect** → GitHub's install screen (`githubAppInstallUrl`), where the repository is added back             |

- **The permission state belongs to the installation, not the repository.** GitHub asks each
  installation to accept the new permissions once, so every row of that account shows the line
  together. The mock puts it on `acme-labs/acme-infra` while `acme-inc` has already accepted.
- **Its copy names who can fix it** — an owner of that GitHub account — because the admin reading the
  room often is not one, and the person who pressed Run hosted may not be on GitHub at all.
- **The state is read from MOTIR-6449's `hostedRunWriteAccess`**, the same check that refuses a run,
  so the room and the refusal cannot disagree.

## 18.2 · Panel 1b — back from GitHub: one banner line revised

`github.banner.installed` changes (18.4): with Motir Integration asking for write, _"can now read your
selected repositories"_ is no longer the whole truth. Every other `?github=` status
(`lib/github/bannerStatus.ts`) is unchanged and renders verbatim through `GitConnectBanner` in its
shipped tone. Accepting updated permissions happens on GitHub's installation page, which may not
redirect back; the row reads **ready** on the next load, so **the row is the record, not the banner**.

## 18.3 · Panel 2 — Run hosted, refused, per repository

MOTIR-684's refused slot (the `notice warn` in the run section). **A run is refused as a whole and
explained per repository**: a hosted run covers every repository its card touches — several for a
multi-repository card, the union of the children's for a parent — and all are checked before
anything is minted or booted.

- The lead keeps the slot's `Not started — ` prefix and counts the repositories it cannot write.
- One list item per refused repository: the repository (mono), the decision's reason **verbatim**,
  and **Open in Repositories** — a link to that repository's row in the room, not straight to
  GitHub, because the room names who has to act.
- The two reasons, verbatim from the decision (`owner/name` and the account filled):
  - `Motir Integration can no longer reach owner/name — reconnect it in the Repositories room`
  - `hosted runs on owner/name need Motir Integration's updated permissions — an owner of <account> accepts them on GitHub`
- A repository Motir created never appears; a run is never partly started.

The mock draws two cases: a card spanning two repositories (one refused) and a parent whose children
touch three (two refused).

## 18.4 · Copy — every string, verbatim

| Where                       | String                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| row · ready                 | `Hosted runs can write here — Motir’s app pushes their branches and opens their pull requests.`                                                                                                                                              |
| row · permissions           | **`Needs updated permissions.`** `Motir Integration on {account} can’t write yet — an owner of {account} accepts its updated permissions on GitHub. Until then a hosted run that touches this repository is refused before anything starts.` |
| row · permissions · button  | `Review permissions on GitHub`                                                                                                                                                                                                               |
| row · can't reach           | **`Motir Integration can no longer reach {owner/name}.`** `Its installation was removed or suspended, or no longer includes this repository. Reconnect it on GitHub; until then a hosted run that touches it is refused.`                    |
| row · can't reach · button  | `Reconnect`                                                                                                                                                                                                                                  |
| refused · lead              | `Not started — Motir’s app can’t write to {n} of this run’s {total} repositories.`                                                                                                                                                           |
| refused · detail            | `Nothing was booted and nothing was charged. Each repository below says what fixes it; an owner of the GitHub account may have to do it.`                                                                                                    |
| refused · item              | `{owner/name}` · the decision's reason verbatim · `Open in Repositories`                                                                                                                                                                     |
| return banner · `installed` | **CHANGED:** `GitHub App installed — Motir can now read your selected repositories, and its app pushes hosted runs’ branches and opens their pull requests.` (was `… Motir can now read your selected repositories.`)                        |
| other return banners        | `repos_updated` / `install_expired` / `install_unbound` / `install_error` — shipped, unchanged                                                                                                                                               |

## 18.5 · Primitives — every element and its role

| Element                        | Primitive                                                | Role                                         |
| ------------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| repository row                 | the shipped `connected li` (`li-top`)                    | unchanged                                    |
| hosted-runs line               | `agent-line` (quiet) / `agent-line--warn`                | can Motir's app write this repository        |
| Review permissions / Reconnect | `Button` secondary sm with the external-link icon        | hands off to GitHub                          |
| return line                    | `SettingsBanner` success                                 | the round trip just taken                    |
| refused notice                 | MOTIR-684's `notice warn` in `secBody`                   | why the run did not start                    |
| refused list                   | `refused-list` — `li` with `rr-repo`, `rr-why`, `a.link` | one refused repository and where it is fixed |

## 18.6 · Token roles

Only `--el-*` and shape tokens.

| Element                      | Colour                                                                                         | Shape                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| line · quiet                 | text `--el-text-secondary` · check `--el-success`                                              | —                                          |
| line · warn                  | `--el-warning-surface` · `--el-warning-text` · icon `--el-warning` · border `--el-border-soft` | `--radius-card`                            |
| secondary button             | `--el-button-border` · `--el-text`                                                             | `--height-btn-sm` · `--spacing-btn-x-sm`   |
| banner · success             | `--el-tint-mint` · `--el-text-strong`                                                          | `--radius-card` · `--spacing-card-padding` |
| refused notice               | `--el-warning-surface` · `--el-text-strong`                                                    | `--radius-control`                         |
| refused list · repo / reason | `--el-text-strong` (on the warning surface) · separator `--el-border-soft`                     | —                                          |
| refused list · link          | `--el-link` (the shipped `.link`)                                                              | —                                          |

## 18.7 · Explicitly OUT of scope here

- **How write access is computed** and **the refusal itself** — MOTIR-6449 and MOTIR-690.
- **Granting the permissions on the Apps** — MOTIR-6523 (manual).
- **The Hosted by Motir rows** — unchanged; `motir-studio` writes them.
- **Settings → Account → Git** — untouched: a person's GitHub link is not involved in a hosted run.
- **The run section's other states** — MOTIR-684.

## Amendment 2026-11-23 — AWS hosting handover (MOTIR-12125, Story MOTIR-9800)

**Amends § 14 (the take-it-over flow) and its mock `design/repository-set/takeover.mock.html`**, which
stays as drawn. The change is drawn in the delta mock
**`design/repository-set/takeover--aws-handover.mock.html`** (25 panels): the **Entry affordance** (`Take
over AWS hosting` on an AWS-target row and at the flow's start, organisation admins only), the
**Single-repository refusal**, the two-step **Handover step**, the durable **Handover checklist** card at
the top of this room, and the **Upstream addresses list**.

§14.4's placement holds: the room is still `/settings/project/repositories`, and the §14.5 split still
decides what is a dialog (the handover step) and what lives on the room (the checklist, which outlives
the dialog). Serverless and Fly rows keep § 14's flow unchanged.

The full specification — elements, the checklist's row and state table, the permission rule, the
no-payment-detail / no-root-credential rule, the state-to-data map by card key, tokens and copy — is in
**`design/hosting/design-notes.md` § Amendment 2026-11-23 — the takeover handover**, which also covers the
Production panel delta drawn for the same card.

# 20. `repositories-room--scip-upload-credentials.mock.html` — A REPOSITORY'S SCIP UPLOAD CREDENTIAL (MOTIR-12338, redrawn)

**Story MOTIR-12262 · subtask MOTIR-12338 (design) → MOTIR-12340 (the room surface), MOTIR-12345
(the story E2E), 2026-11-28.** A DELTA on §16–§17 (`repositories-room.mock.html`, the room as
MOTIR-4674 and MOTIR-4954 left it) and on the hosted row's `Delete repository` / `Remove from this project` actions MOTIR-11981 ships
(drawn in MOTIR-11980's published design, §19 of its notes). The mock,
[`repositories-room--scip-upload-credentials.mock.html`](repositories-room--scip-upload-credentials.mock.html),
holds only the changed panels. Neither older mock is edited.

**This section REPLACES the version sent back on 2026-11-28** (result at `0db26d4b4`, refused by
the reviewer: _"Wrong design, motir hosted repo upload credential should be generated and maintained
internally"_). That version drew a person minting on a Motir-hosted repository, a hosted show-once
panel, an install-failed form asking the person to copy the token into Actions by hand, and a hosted
revoke confirm. **All four are gone, not kept beside the new panels.** A Motir-hosted repository
now shows a read-only managed state; the imported repository's panels are carried over unchanged.

**Design system (step 1 of the card).** Files read: `package.json` (depends on
`@motir/design-system`, `workspace:*`) and `app/globals.css` (imports
`@motir/design-system/theme.css`). **Verdict: on Motir Design (branch a).** The installed version
is the workspace package (`packages/design-system`), which exports `@motir/design-system/mock`, so
the mock is built with `renderMock` at the project's own axes from its root layout
(`warm-editorial` · `motir` · `motir`), `boardWidth: 'full'`. It was rendered from the SHIPPED
`RepositoriesRoom` → `OrganizationRepositories` and `TakeoverRow`, and the new dialog is composed
from the package's `Modal`, `Input`, `Button`, `Checkbox`, `Pill` and `Spinner`, the way the account
Tokens page composes its show-once (`CreateTokenModal`) and its revoke (`RevokeTokenDialog`).

**The data is not this design's.** The imported fields and the three refusals belong to the motir-ai
card MOTIR-12337 (mint, list and revoke) and to the core routes card MOTIR-12339 that carries them
to the room. The three hosted states, and what the repository row records for them, belong to the
maintenance card MOTIR-12357 (Motir mints, installs and keeps a hosted repository's credential).
The values in the mock (`cgk_…` prefixes, `cgr_…` ids, dates, names, the `motir-managed` name) are
illustrative fixtures only. The name limit (`{max}`) and the live-credential limit (`{limit}`) are
interpolated from what the routes report; the upload host is whatever the mint answers.

## 20.1 · The answer in one line

**Every repository row that has code gains a quiet `Upload credentials` row action**, on the
imported row and the Motir-hosted row alike, and **it opens one dialog per repository**. **On a
Motir-hosted repository that dialog is read-only**: it says Motir manages the credential, shows one
status (installed · repairing · waiting for the code graph) and the credentials Motir made, and its
only next step is the recipe workflow. **On an imported repository it is the person's own mint**:
name and mint at the top, the list below; a mint turns it into the show-once panel, a revoke into
its confirm.

## 20.2 · The decisions

| Question (from the card)                 | Decision                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The access path                          | **A ghost row action**, `Upload credentials` with the `KeyRound` glyph, the room's quiet-action grammar. On an imported row it sits **before** `Remove from this project`; on a hosted row it sits **after** the row's way forward (`Move to my GitHub`, `Take over AWS hosting`) and **before** `Delete repository`, which stays last (MOTIR-11980 §19.3).                          |
| Which rows get the door                  | A row whose repository exists: an organisation link, and a hosted row in the `hosted` register. **No door** on a row with no repository yet (proposed / never created), a hand-off in flight, or a delete that did not finish: none of them has a code-graph repository to upload into.                                                                                              |
| One door or two kinds of section         | **One door, one dialog, two kinds of content**, told apart by the repository's kind. The person learns one place to look; what they find there says plainly whether Motir or they own the credential. The two kinds read clearly different: the hosted dialog opens on a mint callout and a status pill and holds no field and no button; the imported one opens on a form.          |
| The hosted status's tones                | **The pill tones the app already gives these states**: installed `Pill severity="success"` (mint), repairing `Pill severity="info"` (sky, work in progress), waiting for the code graph `Pill tone="awaiting"` (yellow, the tone a decision waiting on somebody wears). No new tone. Each pill sits beside one sentence in `--el-text-secondary`.                                    |
| Why no button on a hosted state          | **The person has nothing to do in any of them.** Repairing is retried by Motir's next pass; waiting ends when the first index lands. A button would suggest a person act the reviewer ruled out. The only link is the recipe docs, the one step a hosted team still takes (adding the workflow).                                                                                     |
| What the hosted list shows               | **The repository's credentials, read-only** (name, prefix, created, revoked). The installed one carries the **Installed in Actions marker**; a credential Motir replaced on a rotation reads `Revoked {date}`; a live row's revoked cell reads `—`. **No row carries an action.** While waiting, nothing exists, so the list is replaced by the waiting status (its empty state).    |
| How much repair detail                   | **None.** The repairing sentence says Motir is putting it back on its next pass and there is nothing to do; which step failed is the maintenance card's log, not the person's concern (the card's assumption).                                                                                                                                                                       |
| Inline section or dialog (imported)      | **A dialog** (`Modal size="lg"`, `max-w-[42rem]`, the Tokens page's width). The token must be dismissed deliberately, and the room's rows are already dense with actions; an inline expansion would push every row below it. The hosted section uses the same dialog for one door.                                                                                                   |
| One dialog or stacked dialogs (imported) | **One dialog, three phases** (manage · shown once · revoke), the `CreateTokenModal` two-phase shape plus a revoke phase. A confirm stacked over the list would be two focus traps; a phase swap keeps one.                                                                                                                                                                           |
| The explicit close (imported)            | The show-once phase has **no close X** (`hideClose`), **ignores Escape and the overlay**, and its one button, `Done`, enables only once the `Checkbox` "I've copied what I need" is ticked. `Done` returns to the manage phase, where the new credential is the top row. The token is not reachable again.                                                                           |
| The revoke weight (imported)             | **`Button variant="danger"`** on a rose callout, the shipped `RevokeTokenDialog`: a revoke destroys something (the next upload is refused), so it takes the danger weight the app already gives a token revoke.                                                                                                                                                                      |
| Where the Revoke action sits (imported)  | **In the live row's `Revoked` cell.** A revoked row shows its date there instead, so the column answers "revoked?" for every row and a revoked row carries no action.                                                                                                                                                                                                                |
| Who may do it                            | **`repository:manage`**. The room's nav entry declares that permission and no view key (`lib/settings/projectSettingsNav.ts`), and the page's destination guard refuses arrival without it (`app/(authed)/settings/project/repositories/page.tsx` via `_guard.tsx`). **So the design draws no member read-only state**: a member who cannot manage repositories never sees the room. |

## 20.3 · Panel 1 — the door

The real room with one imported row (`acme/billing-service`) and two hosted rows
(`motir-projects/acme-shop-web`, `…-api`). Each gains `Upload credentials` in the position §20.2
gives it. Nothing else in the rows changes.

## 20.4 · Panel 2 — Motir-hosted: the Managed credential status in its three states

**Title** `Upload credentials · {repo}`, **description** the one-line hint. Then, top to bottom:

- the **Managed by Motir line** — mint callout (`--el-tint-mint`, `Info` in `--el-success`) naming
  the secret `MOTIR_SCIP_UPLOAD_TOKEN` and the variables `MOTIR_CODEGRAPH_REPOSITORY_ID` and
  `MOTIR_CODEGRAPH_UPLOAD_URL`, and saying nobody needs to copy a token;
- the **Managed credential status** under a `Status` heading (`role="status"`), one pill and one
  sentence:
  - **installed** — `Installed` (success) · _In Actions since {date}. The recipe workflow reads it
    as it is._
  - **repairing** — `Repairing` (info) · _Motir found the credential missing from Actions, or an
    install that didn't finish, and is putting it back on its next pass. There's nothing for you to
    do._
  - **waiting for the code graph** — `Waiting for the code graph` (awaiting) · _{repo} isn't
    registered with Motir's code graph yet, so nothing has been created. Motir installs the
    credential once the first index lands._
- the **Managed credentials list** (installed and repairing only) — the same bordered four-column
  list as the imported one, read-only;
- the **Recipe docs link**, under one sentence saying adding the workflow is the one step left.

The dialog closes with its ordinary close X. **No state carries a button.**

## 20.5 · Panel 3 — Motir-hosted after a rotation

When the secret goes missing Motir cannot read the token back, so it mints a new credential,
installs it, then revokes the old one (the maintenance card's rotation). The list shows both: the
new one with the **Installed in Actions marker**, the replaced one struck through in
`--el-text-secondary` and reading `Revoked {date}`. Drawn at desktop and at 390px, where the list's
cells wrap and the marker wraps under the name.

## 20.6 · No person act on a hosted repository

**A Motir-hosted repository draws no Mint credential button, no Credential name field, no Show-once
token panel and no Revoke action, and no token appears anywhere on the page** — not in the
dialog, the list (only the display prefix), a toast or the row. The mock checks it: no element
under `data-variant="hosted"` contains a button, the name field, the mint label or a token value.

## 20.7 · Panel 4 — Imported: the dialog and the list's four states

**Title** `Upload credentials · {repo}`, **description** the one-line hint. The **Credential name
field** and the **Mint credential button** share a row. Below, the **Credentials list** under a
`Credentials` heading: a bordered card with a column header (`Name · Prefix · Created · Revoked`)
and one **Credential row** per credential, newest first, then the **Recipe docs link**.

- **populated** — live rows have the name in `--el-text`, the display prefix in mono with an
  ellipsis, the created date, and `Revoke`. A revoked row strikes its name through in
  `--el-text-secondary` and reads `Revoked {date}`.
- **empty** — one sentence inside the card, no header.
- **loading** — `Spinner` + `Reading this repository's credentials…` (`role="status"`).
- **error** — a sentence and `Try again` (secondary, `RefreshCw`), `role="alert"`; the mint form
  stays usable.

No row on an imported repository carries the Installed in Actions marker: Motir installs nothing
there (MOTIR-5511).

## 20.8 · Panel 5 — Imported: naming and Mint pending

`Input` with `helperText` at rest. **Empty** (after a submit) and **too long** replace the helper
with the `Input`'s own `error`, and `Mint credential` disables. **Mint pending**: the field and the
button disable, the button shows its `loading` spinner and `Minting…`; the form cannot be re-sent.

## 20.9 · Panel 6 — Imported: the Refusal notice

One sentence, under the mint row, in a rose callout (`role="alert"`), and **the list unchanged** —
no new row. `not registered` and `limit reached` carry no action. `code graph unreachable` carries
**`Retry`** (secondary), which re-sends the same name. A list read refused `not registered` reads
the same not-registered sentence in place of the list.

## 20.10 · Panel 7 — Imported: the Show-once token panel

Title `Copy your upload credential`, lead `{name} for {repo}`. Then, top to bottom: the
**Store-it-yourself line** (sky callout, `Info` in `--el-info`: paste it into your own CI's secret
store; Motir writes nothing into the repository), the **Token field**, the **Repository id field**,
the **Upload host field** (each a read-only mono box with a secondary **Copy button**; after a copy
it reads `Copied` with a `Check` in `--el-success`), the **Never-shown-again warning** (peach
callout), the **Recipe docs link**, the confirm `Checkbox` and `Done`. Drawn just minted, and with
the token copied and the box ticked.

## 20.11 · Panel 8 — Imported: Revoke confirm, pending, revoked

`Modal size="sm"` phase, title `Revoke {name}?`, one rose callout (_The next upload with this
credential is refused. Remove it from your CI's secret store too._), `Cancel` (ghost, back to the
list) and `Revoke credential` (danger, `Trash2`). **Revoke pending**: back on the list, the row's
action holds its `loading` state (`Revoking…`, disabled). **Then** the row reads `Revoked {date}`,
struck through, with no action.

## 20.12 · Panel 9 — dark and 390px

The hosted installed dialog and the imported show-once in dark; the imported show-once at 390px,
where the field boxes wrap (`break-all`, the `CreateTokenModal` rule) and the Copy buttons keep
their width.

## 20.13 · Elements, by the name the code card and the E2E cite

| Element                                                   | Kind     | What it is                                                                                                                                            |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upload credentials section**                            | both     | the dialog's body (`data-element="upload-credentials-section"`, `data-variant="hosted"` / `"imported"`), opened by the row action                     |
| **Recipe docs link**                                      | both     | `--el-link` text link with `MoveUpRight` (`data-element="recipe-docs-link"`); hosted text `Add the CI recipe workflow`, imported `Read the CI recipe` |
| **Managed by Motir line**                                 | hosted   | mint callout (`data-element="managed-by-motir-line"`)                                                                                                 |
| **Managed credential status**                             | hosted   | `Pill` + sentence, `role="status"` (`data-element="managed-credential-status"`, `data-state="installed" \| "repairing" \| "waiting"`)                 |
| **Managed credentials list**                              | hosted   | the read-only Credentials list (`data-element="managed-credentials-list"`); live rows read `—` in Revoked                                             |
| **Installed in Actions marker**                           | hosted   | `Pill severity="success"` (`data-element="installed-in-actions"`)                                                                                     |
| **Mint credential button**                                | imported | `Button variant="primary"`, `KeyRound`                                                                                                                |
| **Credential name field**                                 | imported | `Input` with `label`, `helperText`, `error`                                                                                                           |
| **Mint pending**                                          | imported | the form disabled, the button `loading`                                                                                                               |
| **Show-once token panel**                                 | imported | the dialog's shown phase, `hideClose` (`data-element="show-once-token-panel"`)                                                                        |
| **Token field · Repository id field · Upload host field** | imported | read-only `code` boxes, `--radius-input`, `--spacing-input-x/y`                                                                                       |
| **Copy button**                                           | imported | `Button variant="secondary"`, `Copy` → `Check` + `Copied`                                                                                             |
| **Never-shown-again warning**                             | imported | peach callout                                                                                                                                         |
| **Store-it-yourself line**                                | imported | sky callout                                                                                                                                           |
| **Credentials list · Credential row**                     | imported | bordered list, four-column grid                                                                                                                       |
| **Revoke action**                                         | imported | ghost `Button`, `--el-danger-on-surface`, `hover:bg-(--el-danger-surface)` (the room's remove ink)                                                    |
| **Revoke confirm**                                        | imported | the dialog's revoke phase (`data-element="revoke-confirm"`)                                                                                           |
| **Refusal notice**                                        | imported | rose callout, `role="alert"` (`data-element="refusal-notice"`)                                                                                        |
| **Retry button**                                          | imported | `Button variant="secondary"`, `RefreshCw`                                                                                                             |

**Package parts used:** `Modal`, `Input`, `Button`, `Checkbox`, `Pill`, `Spinner`. **Product-local
component:** `UploadCredentialsDialog` (the dialog, with its hosted read-only body and its
three-phase imported body, specific to this room); no proposed addition to `@motir/design-system`.

## 20.14 · Token roles

| Role                                                 | Token                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| dialog title / name / field label                    | `--el-text`                                                                               |
| hint, helper, prefix, dates, header, status sentence | `--el-text-secondary` (AA on every surface; never `--el-text-muted` here)                 |
| callout copy                                         | `--el-text-strong` on `--el-tint-{mint,peach,sky,rose}`                                   |
| status pills                                         | `Pill` `severity="success"` · `severity="info"` · `tone="awaiting"` (the package's own)   |
| refusal / error / revoke glyph                       | `--el-danger-on-surface`                                                                  |
| Revoke action ink                                    | `--el-danger-on-surface`, hover `--el-danger-surface`                                     |
| inline env-name chips                                | `--el-code-bg` / `--el-code-text`, `--radius-control`, `--spacing-chip-x-4`               |
| field boxes                                          | `--el-surface`, `--el-border`, `--radius-input`, `--spacing-input-x/y`                    |
| list card                                            | `--el-border`, `--radius-card`, rows `--spacing-control-x/y`, dividers `--el-border-soft` |
| callouts                                             | `--radius-card`, `--spacing-card-padding-12` (revoke: `--spacing-card-padding`)           |

## 20.15 · Copy — every string, as `en.json` keys (`repositoryUploadCredentials.*`)

English only; translation is the code card's. The four keys of the sent-back version that drew a
hosted person act (`installedLine`, `installFailedLine`, `revokeInstalled`, `revokeNotInstalled`)
are retired.

| Key                                                    | String                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rowAction`                                            | Upload credentials                                                                                                                                                                                                                                                        |
| `rowActionLabel`                                       | Upload credentials for {repo}                                                                                                                                                                                                                                             |
| `title`                                                | Upload credentials · {repo}                                                                                                                                                                                                                                               |
| `hint`                                                 | This repository’s own CI uses an upload credential to send its SCIP index to Motir’s code graph from the default branch.                                                                                                                                                  |
| `managedLine`                                          | Motir creates this repository’s upload credential, installs it in {repo}’s GitHub Actions as the secret `MOTIR_SCIP_UPLOAD_TOKEN` and the variables `MOTIR_CODEGRAPH_REPOSITORY_ID` and `MOTIR_CODEGRAPH_UPLOAD_URL`, and keeps it working. Nobody needs to copy a token. |
| `statusLabel`                                          | Status                                                                                                                                                                                                                                                                    |
| `statusInstalled` · `statusInstalledBody`              | Installed · In Actions since {date}. The recipe workflow reads it as it is.                                                                                                                                                                                               |
| `statusRepairing` · `statusRepairingBody`              | Repairing · Motir found the credential missing from Actions, or an install that didn’t finish, and is putting it back on its next pass. There’s nothing for you to do.                                                                                                    |
| `statusWaiting` · `statusWaitingBody`                  | Waiting for the code graph · {repo} isn’t registered with Motir’s code graph yet, so nothing has been created. Motir installs the credential once the first index lands.                                                                                                  |
| `notRevoked`                                           | —                                                                                                                                                                                                                                                                         |
| `recipeHostedLine` · `recipeHosted`                    | The one step left to you: add the recipe workflow to {repo}, and its default-branch runs start uploading. · Add the CI recipe workflow                                                                                                                                    |
| `nameLabel`                                            | Credential name                                                                                                                                                                                                                                                           |
| `namePlaceholder`                                      | GitHub Actions                                                                                                                                                                                                                                                            |
| `nameHelper`                                           | Name it after where it will live, so you can tell your credentials apart later.                                                                                                                                                                                           |
| `nameEmpty`                                            | Give the credential a name.                                                                                                                                                                                                                                               |
| `nameTooLong`                                          | Keep the name to {max} characters or fewer.                                                                                                                                                                                                                               |
| `mint` · `minting`                                     | Mint credential · Minting…                                                                                                                                                                                                                                                |
| `listHeading`                                          | Credentials                                                                                                                                                                                                                                                               |
| `colName` · `colPrefix` · `colCreated` · `colRevoked`  | Name · Prefix · Created · Revoked                                                                                                                                                                                                                                         |
| `revokedOn`                                            | Revoked {date}                                                                                                                                                                                                                                                            |
| `installed`                                            | Installed in Actions                                                                                                                                                                                                                                                      |
| `revoke` · `revokeLabel`                               | Revoke · Revoke {name}                                                                                                                                                                                                                                                    |
| `empty`                                                | No upload credentials yet. Mint one, and this repository’s CI can start uploading its index.                                                                                                                                                                              |
| `loading`                                              | Reading this repository’s credentials…                                                                                                                                                                                                                                    |
| `loadFailed` · `tryAgain`                              | Motir couldn’t read this repository’s credentials. Nothing has changed. · Try again                                                                                                                                                                                       |
| `refusedNotRegistered`                                 | {repo} isn’t registered with Motir’s code graph yet, so no credential was made.                                                                                                                                                                                           |
| `refusedLimit`                                         | {repo} already has {limit} live credentials, so no new one was made. Revoke one first.                                                                                                                                                                                    |
| `refusedUnavailable` · `retry`                         | Motir couldn’t reach the code graph, so nothing was made. · Retry                                                                                                                                                                                                         |
| `shownTitle`                                           | Copy your upload credential                                                                                                                                                                                                                                               |
| `shownLead`                                            | **{name}** for {repo}.                                                                                                                                                                                                                                                    |
| `tokenField` · `repositoryIdField` · `uploadHostField` | Token · Repository id · Upload host                                                                                                                                                                                                                                       |
| `copy` · `copied` · `copyLabel`                        | Copy · Copied · Copy {field}                                                                                                                                                                                                                                              |
| `warning`                                              | This is the only time Motir shows this token. Once you close this it can’t be shown again: if you lose it, revoke it and mint a new one.                                                                                                                                  |
| `storeLine`                                            | Paste the token into your own CI’s secret store, with the repository id and the upload host beside it. Motir writes nothing into {repo}.                                                                                                                                  |
| `recipe`                                               | Read the CI recipe                                                                                                                                                                                                                                                        |
| `understood` · `done`                                  | I’ve copied what I need. This token won’t be shown again. · Done                                                                                                                                                                                                          |
| `revokeTitle`                                          | Revoke {name}?                                                                                                                                                                                                                                                            |
| `revokeImported`                                       | The next upload with this credential is refused. Remove it from your CI’s secret store too.                                                                                                                                                                               |
| `cancel` · `revokeConfirm` · `revoking`                | Cancel · Revoke credential · Revoking…                                                                                                                                                                                                                                    |

## 20.16 · a11y

- The hosted status is `role="status"`, so a repair or a first install is announced politely when
  the dialog is open; its pill text is the state's name, never colour alone.
- The imported show-once phase moves focus to the Token field's Copy button; Copy announces
  `Copied` through the button's own text change (polite).
- Refusals and the list error are `role="alert"`; loading is `role="status"`.
- Each Revoke and Copy has its own accessible name (`Revoke {name}`, `Copy {field}`); the row action
  names its repository (`Upload credentials for {repo}`). A hosted live row's `—` carries the
  accessible name `Not revoked`.
- The token is never put in a URL, a toast, the page's state after `Done`, or any log.

## 20.17 · Explicitly OUT of scope here

- The routes, the maintenance job and what the repository row records, any motir-ai or codegraph
  change, the CI workflow and shell recipe, and the user-docs page's own layout.
- Translation of the new copy.
- A read-only view for members without `repository:manage` — the room refuses them (§20.2).
