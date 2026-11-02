# ADR: Story-acceptance video — entitlement axis, storage/retention, org toggle, CI-upload auth

> **This record governs the PIPELINE that produces a receipt. What happens to a
> receipt AFTER it is approved — and to the spec that produced it — is
> `acceptance-receipt-lifecycle.md` (Story MOTIR-2765).** In short: an
> **approved** receipt is immutable, a republish against one is refused rather
> than superseding it, and the spec that produced it then leaves the acceptance
> lane by promotion or retirement. If you are here with a supersede or a
> retention question, read that record's §2 first — this record's
> supersede/retention rules hold for a `pending` receipt, not for a signed one.

- **Status:** Accepted (2026-07-05, drafted for Story MOTIR-1627 per the
  decision-subtask ladder). This is the rung-1 policy the rest of MOTIR-1627
  implements — no acceptance-video code ships until these four decisions are
  pinned. **No application behaviour ships in this subtask** (the ADR only).
- **Amendment (2026-09-19, MOTIR-5787) — WHERE the acceptance decision lives is
  `approval-gates.md` §1's MOTIR-5787 amendment, not this record.** A published
  receipt raises an `acceptance_result` approval gate on the **STORY** that owns
  it — whatever the run target, and never on the E2E subtask that recorded it. On
  a story run that gate is the PRIMARY of two, and its one press also merges the
  story's pull requests; the video itself is never committed and is never what
  is merged. This record's pipeline, entitlement, retention and CI-upload
  decisions are unchanged, and `acceptance-receipt-lifecycle.md` §2's freeze is
  what closes the receipt once that gate is approved.
- **Amendment (2026-09-11, MOTIR-4925 / MOTIR-5169) — §3's TIER is reversed: the
  switch is `Project.acceptanceVideoEnabled`, not an org column.** A setting's tier
  follows its readers and writers, and §3 chose its own by analogy to the
  neighbouring columns on `Organization`. **Decision 1's entitlement is NOT
  amended** — `hasPaidAiPlan` stays org-resolved. §3's default (`true`) stands, with
  existing projects backfilled from their organisation's value. See the amendment
  under §3.
- **Amendment (2026-07-06, MOTIR-1648 / MOTIR-1649) — CI-upload auth (§4) now
  PREFERS keyless GitHub OIDC; the `integration` PAT becomes the FALLBACK.**
  §4 originally pinned a per-org `integration`-scoped API token stored as a CI
  secret. It works, but it imposes **per-org setup friction** (every org mints +
  stores a token), and it overlooked that **MOTIR-810's GitHub App already
  establishes repo→workspace trust**. Amended: for a repo connected via the App,
  the publish authenticates **keylessly** off the customer's GitHub Actions
  **OIDC** identity — verify the Actions OIDC JWT (GitHub JWKS + `aud` + the
  `repository` claim), resolve the repo → `GithubInstallation.workspaceId` (the
  mapping `githubWebhookService` already uses), authorize under that workspace —
  **no token to mint or store**. The `integration` PAT stays as the documented
  **fallback** for repos NOT connected via the App; the `applicable:false`
  (meta/self-host) short-circuit is unchanged. **Keyless-publish actor:** OIDC
  carries no user, but `Attachment.uploaderUserId` is required — the evidence is
  attributed to the **workspace OWNER** (`GithubInstallation` records no
  connecting user, so the workspace-owner membership — `role: 'owner'` — is the
  resolvable, accountable analog of the PAT's owner), an existing User; no
  synthetic user, no nullable FK. Why: removes the
  per-org token friction, reuses existing App trust instead of a parallel
  credential, and matches the modern keyless-CI standard (cloud providers accept
  GitHub OIDC). Implemented by MOTIR-1650 (endpoint) + MOTIR-1651 (BYOK docs /
  Action); §4 below is rewritten to reflect it. This is the "recommend the BEST,
  not the shipped" correction to the original §4.
- **Amendment (2026-09-01, decided by Yue; applied 2026-09-02 by MOTIR-4096) —
  CI NO LONGER UPLOADS THE RECORDING. THE AGENT PUBLISHES IT, over the Motir MCP
  surface.** Only the UPLOADER changed hands. The receipt concept, its
  eligibility gate (§1), its storage and retention rules (§2), the org toggle
  (§3), the publish endpoint and the review flow are all UNCHANGED, and so is the
  recording itself: the acceptance lane still runs Playwright with `video: 'on'`,
  and the clips, traces and `chapters.json` sidecars still land in its report
  artifact — which is now where a reviewer, and the publishing agent, read them
  from. What was RETIRED in this repository, in one change:
  - the lane's publish step and its `ACCEPTANCE_*` env, including the owned-specs
    step that computed `ACCEPTANCE_CHANGED_SPECS` (the MOTIR-1937 ownership
    filter) — it fed nothing else;
  - `scripts/upload-acceptance-video.mjs` and its composite wrapper
    `.github/actions/upload-acceptance-video/` (MOTIR-1651's BYOK Action);
  - `tests/acceptance-video-uploader.test.ts`, which tested both;
  - the job's `id-token: write` grant and its `MOTIR_UPLOAD_TOKEN` secret
    reference — §4's two credentials had no consumer left, and a credential with
    no consumer is one nobody thinks about when deciding whether to rotate it.
    **§4 IS NOT REVOKED — its SERVER side is untouched and still shipped.**
    `lib/github/oidcAuth.ts` and `lib/publishAuth/ciPublishAuth.ts` still accept a
    keyless GitHub-OIDC publish and still fall back to an `integration` PAT, so any
    external CI that wants the BYOK path still has a door. What this repository no
    longer ships is a reference CLIENT for it. See the §4 banner below.
    **And the lane was RENAMED with it**: `Acceptance video` →
    **`Acceptance tests`**, at `.github/workflows/acceptance-tests.yml`. A name
    describing a mechanism the file no longer has is a standing tax on every reader
    — and the header's reasoning was largely ABOUT publishing, so the prose moved
    with the step it explained rather than being left to explain a mechanism that
    is gone. `nextjs-prisma-vercel-starter` carries its own copy of the lane and
    the Action; MOTIR-4097 follows there.
- **Amendment (2026-09-06, applied by MOTIR-4704) — THE MCP DOOR THE AMENDMENT
  ABOVE NAMED NOW EXISTS. For four days it did not.** The 2026-09-01 amendment
  retired the uploader and said the agent publishes "over the Motir MCP surface";
  that surface had no acceptance publisher on it, and neither did the two other
  documents that repeated the sentence (`motir-core/CLAUDE.md`,
  `playwright.acceptance.config.ts`). The card that retired the uploader pointed
  at `attach_file`, which cannot be the door — it writes a plain `Attachment`
  with no evidence row, no status, no freeze rule and no panel. So the capability
  was shipped, the routes were live, and every document an agent read named a
  door that was not there. **The failure was SILENT in the way this whole ADR
  exists to prevent:** an agent that reads the rule, finds no tool, and moves on
  produces a green lane, a merged pull request and a story with no receipt.
  - The door is **`create_acceptance_upload` + `publish_acceptance_result`**,
    thin adapters over `createUploadTokens` / `recordFromPathnames` — §2's
    storage rules, §1's eligibility gate, the prefix check and the authoritative
    `head` all still run in the service, once.
  - **TWO calls, not one.** `publish_design_result` takes its assets inline;
    a recording cannot. The MCP route is a serverless function whose body cap
    the mint-then-PUT path exists to bypass, and base64 bytes would have to be
    EMITTED by the agent — 6.7 M characters for a 5 MB clip. So the agent mints
    a presigned PUT, uploads the bytes directly, and registers the pathname.
  - **The runner is now ASKED.** `WHAT_TO_DO.test` in
    `lib/dispatch/promptTemplate.ts` gains the publish step on a card that
    records a receipt — conditionally, because `type: test` is every test card
    and only some of them record one. This is the half that makes the
    planner/runner pair actually close: the planner writes the acceptance E2E
    subtask, and the product now tells the runner what to do with what it
    recorded, instead of leaving that to prose in the card body.
  - **Why a tool at all, rather than pointing agents at §4's HTTP routes:** the
    routes ask the runner to know a Motir address and hold a PAT, which a
    dispatched agent in a repository Motir does not own has neither of. That is
    the same requirement the retired script could not meet, one layer up. MCP is
    the door that travels, on a credential the runner already holds.
- **Amendment (2026-10-01, decided by Yue; applied by MOTIR-7253) — CI PUBLISHES
  AGAIN WHERE THE REPOSITORY'S LANE CARRIES THE UPLOADER.** For the repositories
  Motir writes itself — motir-core, and every project generated from
  `nextjs-prisma-vercel-starter` (which is what a Motir-hosted repository is seeded
  from, `lib/github/repoProvisioning.ts`) — CI is the more reliable publisher of
  the receipt, so the uploader returns. The 2026-09-01 amendment made the receipt
  exist only if the agent remembered two calls and could reach MCP from its
  sandbox, and a missing receipt looks exactly like a successful run; MOTIR-4704
  was that failure happening. The retirement's reason still holds for every
  OTHER repository — a publisher that must be present in a repository is one a
  customer's repository cannot be relied on to carry — so this is a reversal for
  the two repositories Motir controls end to end, not a revocation.
  - **What is restored:** `scripts/upload-acceptance-video.mjs`, its composite
    `.github/actions/upload-acceptance-video/` and
    `tests/acceptance-video-uploader.test.ts`, from `76add02b1b^`; the lane's
    owned-specs step (the MOTIR-1937 ownership filter); and a publish step on the
    shard job, `if: success() && github.event_name == 'pull_request'`. A `push:
main` baseline, a `merge_group` run, a red run and a PR that owns no spec
    publish nothing. The lane keeps its name, `Acceptance tests`.
  - **OIDC ONLY.** The shard job alone holds `id-token: write`; no workflow
    references a Motir token. The script keeps a PAT path (`MOTIR_PUBLISH_TOKEN`,
    the action's optional `token` input) for an external repository with no App
    connection — §4's fallback — and Motir's own lanes never pass it. A run
    without an OIDC token (a fork PR) logs why and exits 0.
  - **`producedByKey` is the PR's own card key** (its head ref, then its title),
    falling back to the recording's story key, never a constant — the old lane
    sent `MOTIR-1638`. The service returns the existing receipt for the same
    `commitSha` + `producedByKey` (`recordFromPathnames`), and an agent publishing
    over MCP sends its card key, so a CI publish and an agent publish of the same
    commit collapse to ONE receipt instead of superseding each other.
  - **The closed-story skip keys on `ACCEPTANCE_EVIDENCE_STORY_CLOSED`.** MOTIR-5872
    replaced the approved-receipt refusal the old client skipped on; a verbatim
    restore would have turned every skip into a red lane.
  - **What stays:** the 2026-09-01 and 2026-09-06 amendments above stand as the
    record of their moment, and the MCP door (`create_acceptance_upload` +
    `publish_acceptance_result`) stays open for every other repository and custom
    process. The server side — routes, eligibility gate, receipt lifecycle,
    acceptance panel — is unchanged. Projects ALREADY generated from the starter
    are not back-ported: a template generate is a copy, so their lane stays
    record-only and their agents keep publishing over MCP, which still works.
- **Story / Subtask:** MOTIR-1627 (Story acceptance gate — E2E acceptance video,
  review & approve, BYOK, motir-ai-plan-gated) · Subtask MOTIR-1628.
- **Consumed by:** MOTIR-1629 (data model + video allowlist), MOTIR-1630
  (eligibility — org toggle + AI-plan gate), MOTIR-1631 (publish endpoint),
  MOTIR-1632 (Playwright recording + CI uploader), MOTIR-1633 (design),
  MOTIR-1634/1635/1636 (panel / org card / board badge), MOTIR-1637/1638 (tests).
- **Builds on:** `billing-tiering.md` (the two entitlement axes + the
  2026-06-24 amendment that bundles the `scaled` tier into every paid AI plan),
  `organization-tier.md` (`Organization` = billing entity, org-scoped),
  and the shipped attachment/blob pipeline (`attachmentsService`, `lib/blob/*`).
- **Supersedes / superseded by:** none.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `organization-tier.md`): a decision record is a markdown
> file under `docs/decisions/`, structured **Status → Context → Decision →
> Consequences**, with the load-bearing facts pinned in explicit tables so
> downstream code has one authoritative source to implement against.

---

## Context

MOTIR-1627 closes the BYOK dispatch→review loop with a **human acceptance gate at
the story level**: a story's E2E, on a green run, records a short **video**; the
video is attached to the story as _acceptance evidence_; a reviewer watches it in
an in-app player and **Approves** (`in_review → done`) or **Requests changes**.
"Verification" (the mandatory E2E + integration tests) proves correctness and
gates the merge; "acceptance" is the human judging _"is this what I wanted"_ from
the E2E's own **video receipt** rather than re-driving the app by hand.

Storing video is the only new **cost** this feature introduces, so it must be
gated. Four load-bearing choices decide _who can generate video, how much it may
cost, where the switch lives, and how CI is authorised to upload it_. Each is
grounded in shipped billing/attachment reality, not re-invented.

### Shipped substrate this reconciles against (verified 2026-07-05)

| Fact                                                                                                                                       | Where                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Two entitlement axes: **Axis A** = paid AI plan (`getAiAccess(...).hasPaidAiPlan`); **Axis B** = the `scaled` tier that lifts storage caps | `docs/decisions/billing-tiering.md`; `lib/services/billingService.ts:192,221` |
| **Every paid AI plan bundles the `scaled` tier** (1 tracker seat included → caps lifted) — Axis A ⟹ Axis B                                 | `billing-tiering.md` amendment 2026-06-24 (8.1.22 / MOTIR-1316)               |
| `getAiAccess` returns `applicable:false` off-cloud (`!isCloudBilling()`) **and** for the meta org (`org.isMeta`)                           | `lib/services/billingService.ts:193,214`                                      |
| Per-file upload limit: `free` 10 MB → `scaled` 100 MB (off-cloud = 10 MB baseline)                                                         | `entitlementsService.resolvePerFileLimitBytes` (`:145`)                       |
| Total-storage cap: `free` 2 GB → `scaled` 100 GB; no-op off-cloud; sums `Attachment.sizeBytes`                                             | `entitlementsService.assertWithinStorageCap` (`:156`)                         |
| Generic upload allowlist (no video today)                                                                                                  | `lib/blob/allowlist.ts` (`ALLOWED_UPLOAD_TYPES`, 415 otherwise)               |
| Orphan-GC storage backstop — blob-first sweep, 7-day safety window, system context                                                         | `attachmentsService` `ORPHAN_SAFETY_WINDOW_MS` (`:97`), sweep (`:503`)        |
| Org admin write-authority helper (mirror `renameOrganization`)                                                                             | `organizationsService.assertOrgAdmin` (`:623`)                                |
| External-agent write auth: the `integration` API-token scope                                                                               | `lib/mcp/scopes.ts:34` (`apiTokensService.verify`)                            |

---

## Decision

### 1. Entitlement axis — the "motir-ai plan" gate (reconciling the two axes)

The user's intent — _"only a motir-ai plan can generate video, because it gives
storage"_ — conflates Axis A (the AI plan) and Axis B (the storage-cap tier).
Under the 2026-06-24 billing amendment these are no longer independent for paid
orgs: **every paid AI plan bundles the `scaled` tier**, so `hasPaidAiPlan`
(Axis A) _implies_ the lifted 100 MB / 100 GB storage headroom (Axis B). That
makes the intent coherent — gate on the AI plan and the storage that makes video
affordable comes with it — while keeping the cost bound explicit.

**Decision (pinned):**

| Check                                                             | Axis | Rule                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature **eligibility** (may this org generate video?)            | A    | `getAiAccess(...).hasPaidAiPlan === true` **AND** the org toggle (decision 3) is ON                                                                                                                                                                                        |
| Per-upload **cost bound** (enforced on every publish, regardless) | B    | `entitlementsService.resolvePerFileLimitBytes(orgId)` (per-file) **AND** `assertWithinStorageCap(orgId, bytes)` (total)                                                                                                                                                    |
| **Off-cloud / self-host / meta org**                              | —    | `getAiAccess` → `applicable:false`: **UNGATED → eligible=true** (no AI plan to buy, no storage to meter; the panel shows the player directly, no upsell). This is what lets a self-hoster use the feature AND the moooon META org publish its own self-test dogfood video. |

So the AI plan **gates the feature** and the storage cap **still bounds the
cost** — the cap is defence-in-depth (a paid org is `scaled`, so 100 MB/file is
the ceiling; the ≤ few-MB clip target in decision 2 sits far under it, but the
cap is still asserted so a misconfigured recording can never blow the budget).
Eligibility is computed once (a single `acceptanceVideoEligibilityService`,
MOTIR-1630) so the panel, the publish endpoint, and the org toggle all agree.

### 2. Storage / retention (cost control)

| Knob                 | Value                                                                                                                                     | Enforced by                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Duration**         | **No cap.** The clip runs as long as the Story's flow needs — see the watchability amendment below                                        | Not enforced; bounded upstream by Story scope (planner) and by the size ceiling |
| **Resolution cap**   | 1280×720 (720p), `video: { mode: 'on', size: { width: 1280, height: 720 } }`                                                              | Playwright `use.video`                                                          |
| **Target size**      | a few MB; **hard ceiling = the org's per-file limit** (100 MB `scaled`)                                                                   | `resolvePerFileLimitBytes` at publish; publish rejects (413) over it            |
| **Format**           | `video/webm` (Playwright's native output) primary; `video/mp4` also allowlisted                                                           | allowlist (MOTIR-1629)                                                          |
| **Retention**        | **keep the latest evidence per story**; a new green run **supersedes** the prior current (history rows retained, only one marked current) | `acceptanceEvidenceService` supersede-on-create (MOTIR-1629)                    |
| **Superseded blobs** | become orphaned Attachments → reclaimed by the existing **orphan-GC** sweep (blob-first, 7-day window)                                    | `attachmentsService` orphan GC — no new GC path                                 |
| **Plan lapse**       | **keep existing videos read-only + stop generating new** (do NOT prune paid-for evidence on downgrade)                                    | eligibility gate blocks new publishes; existing rows/blobs untouched            |

#### Amendment 2026-07-28 (Yue) — no duration cap; the receipt must be WATCHABLE

The original ≤ 60 s duration cap is **withdrawn.** It was the wrong lever, and it
was pushing in the wrong direction.

**Why it was wrong.** The cap treated clip length as the cost to control, but
length is not a cost here — the _size_ ceiling already bounds cost, and it is the
thing actually enforced at publish. What the cap really constrained was how much
of a Story a recording was allowed to show, which is backwards: the video is an
acceptance _receipt_, and a receipt that omits half the flow is worthless no
matter how small it is. It also predates per-story acceptance specs (MOTIR-1700);
the number was set against the original single-flow dogfood, not a five-phase
Story walk-through.

**What replaces it — two rules pulling in the right direction:**

1. **The clip must be WATCHABLE by a human.** A reviewer approves a Story by
   watching this video (Principle #18), so it has to be paced for eyes, not for
   the runner. Driven at machine speed a full five-phase Story flow finishes in
   ~5 seconds with every chapter stacked in the first four — technically green,
   and useless as evidence. The recorded happy path therefore **holds the frame
   after each user-visible action** so a person can actually see what happened.
   (Worked example: MOTIR-921's cadence spec, ~5 s → ~78 s, chapters spread
   1.8 / 30.6 / 51.3 / 59.7 / 64.1 s.)

   This is pacing, **not** synchronisation — the `waitForTimeout` ban in
   `CLAUDE.md` still holds in full. Every real wait stays an authoritative signal;
   the hold only ever comes _after_ the assertion that proved the state, so it can
   never mask a race.

2. **Length is bounded upstream, by STORY SCOPE — the planner's job, not the
   spec's.** If a Story's acceptance video is getting unreasonably long, the
   signal is that the _Story_ is too big, and the fix belongs in planning (split
   it), not in trimming the receipt until it no longer shows the feature. A
   too-long video is a planning smell to act on, never a reason to speed up the
   recording.

The **size** ceiling is unchanged and remains the real cost bound: the enforced
`MAX_UPLOAD_BYTES` / per-file limit at publish. At 720p a paced multi-minute clip
still lands in single-digit MB (MOTIR-921's ~78 s clip is 4.4 MB against a 10 MB
enforced cap), so removing the duration cap does not move the cost envelope.

**Retention rationale (industry mirror):** CI systems bound video/artifact cost
by _recency + short retention windows_, not by keeping every run — GitHub Actions
artifacts default to a 90-day window and are the last-run receipt, and Playwright
itself defaults to `video: 'retain-on-failure'` (keep only what you need). We
keep exactly **one** current acceptance receipt per story and let the existing
orphan-GC reclaim the superseded blobs, so per-story storage is O(1), not O(runs).
Plan-lapse keeps evidence read-only because the video is a _record of an accepted
story_, not an ongoing service — pruning it would destroy audit history the org
already paid to produce.

#### Amendment 2026-08-04 (MOTIR-1911) — the size ceiling applies PER ARTIFACT, and the trace is not the receipt

The amendment above leans on the size ceiling as "the real cost bound", and it
is. What neither it nor the table said is **which artifact** the ceiling bites,
and the answer turned out to matter: a recording publishes **two** files against
the same per-file cap — the video and the Playwright **trace** — and until now an
over-cap either one failed the whole publish.

**Measured** (run 30579274284, the first run after MOTIR-1905 unblocked
publishing): the cadence recording's `video.webm` was **6,340,169 B** — squarely
inside the envelope this ADR predicts — and its `trace.zip` was **118,924,401 B**,
past the 104,857,600 B cap. Seven of eight stories got their receipt; MOTIR-813
was the one that did not, and it lost it to the artifact that is **not** the
receipt. (A `trace: 'on'` recording bundles a screenshot stream plus every
network body, so trace size tracks the journey's length and weight, not the
clip's — a 1.6-minute walk-through produces a ~113 MB trace beside a 6 MB video.)

Also worth stating plainly, because the failure text hid it: the 100 MB is **not
a Vercel Blob platform ceiling**. It is Motir's own per-file entitlement
(`resolvePerFileLimitBytes`), minted into the client upload token as
`maximumSizeInBytes`.

**Which deployments the 10 MB baseline actually reaches: only SELF-HOST.** §1 gates
publishing on `hasPaidAiPlan`, and by the Axis A ⟹ Axis B bundling above that is the
very flag which lifts the cap — `pmTierForOrg` short-circuits
`aiIncludedSeat → 'scaled'` → 100 MB. A cloud org without a paid plan is capped at
10 MB but is refused at the eligibility gate (402) before any upload, so its cap never
binds. Off-cloud is the one place the two diverge: `resolvePerFileLimitBytes` returns
the baseline from its `!isCloudBilling()` branch before any tier is read, while
eligibility is deliberately ungated (`applicable:false ⇒ eligible`, §1). Open gate,
tight cap — and at the measured ~59 KiB/s of a 720p paced clip, the VIDEO arm becomes
reachable there at roughly three minutes of recording rather than ~29. That asymmetry,
not a tier boundary a customer might sit on, is what `ACCEPTANCE_MAX_ARTIFACT_BYTES`
exists to let a self-hoster correct.

**The rule, per artifact:**

| Artifact  | Over the per-file cap                                                                        | Why                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Video** | **Not published.** Reported + annotated, and the publish step exits non-zero.                | The video **is** the receipt (Principle #18). There is nothing to fall back to, so this is a defect to fix, not one to route around. |
| **Trace** | **Dropped.** The video publishes without it; reported as a WARNING and the step stays green. | The trace is a debugging aid. Costing a story its evidence to save an attachment nobody accepts a story on is the bug, not the fix.  |

And the boundary is now **checked up front rather than discovered**: the uploader
measures every artifact beside the watchability verdict, before any auth or token
mint, and reports through the same annotation + job-summary channels
`continue-on-error` cannot swallow (MOTIR-1905). The mint additionally returns its
own `maxBytes`, so a deployment on a different tier fails with a message naming
the file, its size and the cap — not with @vercel/blob's opaque "File is too
large, the file length cannot be greater than 104857600 bytes" thrown from inside
`put`.

**Not chosen: lowering trace fidelity for the lane** (`screenshots: false`, or
`retain-on-failure`). It would shrink the artifact, but this lane exists to record
the GREEN run, and a trace that is only kept on failure is no trace at all here.
The per-artifact rule fixes the actual defect — a story losing its receipt — and
leaves the trace as the best-effort extra it always was. If trace size becomes a
CI-storage problem in its own right, that is the change to make then.

### 3. Org-level scope + default

The switch is an org-wide **Boolean column on `Organization`** (mirrors
`aiIncludedSeat` / the existing org flags), set through `organizationsService`
behind `assertOrgAdmin` + `PATCH /api/organizations/[orgId]`, surfaced on
`app/(authed)/settings/organization` as an `OrgGeneralCard` sibling.

| Choice          | Decision                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Column          | `Organization.acceptanceVideoEnabled Boolean`                                                                                                                                                                      |
| **Default**     | **`true`** (ON) for every org — an eligible (paid) org opted into the cost by paying; a non-eligible org's toggle is moot (the entitlement gate blocks generation regardless), so a default of ON never leaks cost |
| Write authority | org admin only (`assertOrgAdmin`), same as rename                                                                                                                                                                  |
| Non-plan orgs   | the toggle has no effect (eligibility=false); the panel upsells instead                                                                                                                                            |

Default ON (not OFF) because the feature is the story's whole point and the cost
is already bounded by decisions 1–2; forcing every paid org to hunt for a switch
before their first acceptance video is friction with no cost upside.

#### Amendment 2026-09-11 (MOTIR-4925 / MOTIR-5169) — the switch is PROJECT-scoped; §3's TIER is reversed, its DEFAULT stands

**§3 above is superseded on one axis and unchanged on every other.** The switch is
now **`Project.acceptanceVideoEnabled`**, written at the project tier behind that
project's own manage authority. The `Organization` column is RETIRED rather than
kept as a floor, in three phases (see _How it was removed_, below).

**Why the original tier was wrong — and the general rule, which is the part worth
keeping.** §3 chose the tier in its own first sentence, by ANALOGY: _"an org-wide
Boolean column on `Organization` (mirrors `aiIncludedSeat` / the existing org
flags)"_. Everything after that sentence argues the DEFAULT, ably; nothing argues
the tier at all. And a survey of a table's existing columns can only return one of
them, so it returns the best-fitting neighbour and never the finding that the value
is an instance of a concept the product already has a container for.

> **Decide a setting's tier by tracing its READERS and its WRITERS, never by which
> surface or column it resembles.**

Applied here, the trace is short and it does not point at the organisation. The
readers are the item panel, the CI publish gate and the MCP publish gate; the
writers are the settings control and the panel's own turn-on action. Nothing in
billing, identity or security touches the flag — and nothing in planning, board,
estimation, fields or components does either. What those consumers add up to is an
**approval gate**: the flag decides whether a finished story is held for a person's
decision. That is a question about how a team works, and every other work-process
setting in this product is already `projectId`-scoped, without exception. The
organisation column was the single row breaking an otherwise total rule, which is
exactly why it read as a convention until somebody checked.

**What it cost while it stood.** One org admin answered for every project beneath
them. A UI product and a library in the same organisation want opposite answers,
and the person who owns a project's process could not set it — while an org admin
who need not belong to that project could.

**⚠️ DECISION 1 IS NOT AMENDED. The ENTITLEMENT stays with the organisation.**
`hasPaidAiPlan` is bought once, for the account, and
`acceptanceVideoEligibilityService` remains the only place the AND of the two is
computed. The two halves now live at different tiers on purpose: _may this account
use the feature_ is a billing fact, and _does this project hold its stories for
approval_ is a process fact. Moving the second one is not an argument for moving the
first — per-project entitlement would be a billing change wearing a settings
change, and this amendment does not make it.

**§3's DEFAULT survives verbatim, and so does its reasoning.** The project column
is `@default(true)` for exactly the reason §3 gives. But the default is not what
makes the migration safe: every existing project is **BACKFILLED from its owning
organisation's current value**, because an organisation that had deliberately turned
acceptance video OFF must not find every project under it turned back on. A switch
that flips itself is a worse failure than the wrong tier it replaces — the wrong
tier at least does what the person who set it asked.

**Where the switch now lives.** `Project settings ▸ Approvals`
(`/settings/project/approvals`), a room for the switches that decide which approval
gates a project raises, gated on `workflow:manage`. The room's argument — its
readers/writers table, the three rejected candidate rooms, and why a room rather
than a card bolted onto an existing page — is
`design/projects/design-notes.md` § _⭐ Approvals — the gate switches_ (MOTIR-4942).
It is NOT restated here: a decision with two homes drifts.

**How it was removed, and why not in one change.** A Prisma read with no explicit
`select` emits every scalar the model DECLARES, so the datamodel line is itself the
last reader of a column, and `fly.toml`'s `release_command` migrates before any new
machine takes traffic. Dropping the column in the same release that removes the
field therefore runs the migration under the PREVIOUS image and 500s every read of
`Organization` for the length of the rollout. So the removal is three phases —
readers first, then `@ignore` the field and RELEASE, then drop the column carrying
the `-- @client-stopped-selecting:` marker `tests/contract-phase-guard.test.ts`
requires. `docs/decisions/delivery-reader-migration.md` §6a / §6b is the record.
The three phases shipped as MOTIR-5172 (readers), MOTIR-5173 (`@ignore`, verified
deployed on every machine by MOTIR-5194) and MOTIR-5195 (the drop, migration
`20260919140000_drop_organization_acceptance_video_enabled`). The column no longer
exists.

**The reversal condition.** This amendment would be wrong if an organisation needed
to IMPOSE acceptance approval on every project beneath it — a floor a project cannot
raise. That is a different feature from a switch, not a rollback of this one: it
wants an org-tier POLICY plus a project-tier setting that the policy constrains, and
both tiers would exist. Nobody has asked for it, and the request that produced this
amendment was the opposite one. So if an org-wide answer returns, it returns as a
policy beside this switch, never as this switch moving back.

### 4. CI upload auth (BYOK) — keyless GitHub OIDC, `integration` PAT fallback

> _Amended 2026-07-06 (MOTIR-1648 / MOTIR-1649): keyless OIDC is now the PRIMARY
> path; the `integration` PAT is the fallback. The original PAT-only reasoning is
> preserved as the fallback bullet below._
>
> ⚠️ _Amended 2026-09-01 (MOTIR-4096): **motir-core's own CI no longer uses either
> credential.** The SERVER side of this section is unchanged and shipped —
> `lib/publishAuth/ciPublishAuth.ts` still verifies a keyless GitHub-OIDC publish
> and still falls back to an `integration` PAT — but the CLIENT that used them
> here (the publish step, `scripts/upload-acceptance-video.mjs`, and the
> `.github/actions/upload-acceptance-video/` Action MOTIR-1651 shipped for BYOK
> consumers) is retired. Motir's own receipt is published by the AGENT, through
> `create_acceptance_upload` + `publish_acceptance_result` on the MCP surface
> (MOTIR-4704 — those tools did not exist when this banner was written)._
>
> ⚠️ _Amended 2026-10-01 (MOTIR-7253): **motir-core's own CI uses the OIDC half of
> this section again**, and so does every project generated from the starter. The
> shard job of `.github/workflows/acceptance-tests.yml` holds `id-token: write` and
> publishes through the restored `.github/actions/upload-acceptance-video/` from a
> green `pull_request` run. The PAT half stays what it always was — the fallback for
> a repository with no App connection — and no Motir workflow passes one. This
> section is the contract the restored client implements, and the one an external
> CI may implement against too. `docs/e2e/acceptance-video-byok.md` carries the
> same note._

No artifact-upload endpoint exists. The BYOK model is: **the user's own CI** runs
the acceptance E2E and POSTs the video to a new motir-core publish endpoint.

**Decision: authenticate keylessly via GitHub OIDC when the repo is App-connected;
fall back to an `integration`-scoped API token otherwise.**

- **Primary — keyless GitHub OIDC (no secret).** A repo connected via the
  MOTIR-810 GitHub App already has a `GithubInstallation` binding repo → workspace.
  The customer's Actions job requests an OIDC token (`permissions: id-token: write`)
  and presents it; the publish endpoint verifies the JWT against GitHub's JWKS
  (`token.actions.githubusercontent.com`, checking `aud` + expiry + the
  `repository` claim), resolves the repo → `GithubInstallation.workspaceId` (the
  resolution `githubWebhookService` already uses), and authorizes the publish under
  that workspace — the **same eligibility + cap checks** as any path (OIDC is not a
  bypass). **No token to mint or store**, reusing the App trust already established
  instead of a parallel credential. This is the modern keyless-CI standard (cloud
  providers accept GitHub OIDC for keyless auth).
- **Fallback — the `integration` API-token scope.** For a repo NOT connected via
  the App, reuse an existing API token with the `integration` scope
  (`lib/mcp/scopes.ts:34`, verified by `apiTokensService.verify`) as a CI secret —
  publishing an acceptance receipt from CI is exactly an external-agent integration
  write. The endpoint authenticates the token, resolves its workspace/actor, then
  applies the same eligibility + cap checks (a token for a non-eligible org still
  gets 402/403).
- **Keyless-publish actor.** OIDC carries no user, but `Attachment.uploaderUserId`
  is required. `GithubInstallation` records no connecting user, so the evidence is
  attributed to the **workspace OWNER** — the `role: 'owner'` membership resolved
  via `workspaceMembershipRepository.findStandInManagerByWorkspace`, the accountable analog
  of the PAT's owner — an existing User in the workspace; no synthetic user and no
  nullable FK. The **workspace** is the authorization scope either way.
- **Not** a brand-new service bearer: that would duplicate token issuance,
  rotation, and scoping for one endpoint. (Epic 9's _hosted_ runner uses its own
  service principal inside its sandbox — explicitly out of scope here.)

#### Amendment 2026-07-31 (Yue · MOTIR-1937) — WHICH RUN may publish a story's receipt

> ⚠️ **Superseded in part by the 2026-09-01 amendment (MOTIR-4096): the CI
> uploader this section reasons about no longer exists.** The reasoning is kept
> as the record of why the lane is shaped the way it is; the files it names
> (`scripts/upload-acceptance-video.mjs`, `tests/acceptance-video-uploader.test.ts`,
> the publish step) are retired, and the lane is now
> `.github/workflows/acceptance-tests.yml`.

The original decision settled **how** CI authenticates and never said **which runs**
may publish. That gap had a live cost, so the answer is recorded here rather than
left to be re-derived from `ci.yml`.

**What went wrong.** The `acceptance-video` leg's only gate was a branch-prefix skip
(`seed/` / `design/` / `docs/`), so every ordinary `subtask/*` PR ran the whole lane.
Combined with two properties decided elsewhere — publishing **supersedes** (§2's
retention rule) and the target story comes from the **recording's own sidecar**, which
outranks the PR ref (MOTIR-1684) — any code PR republished the receipts of every story
that has a chaptered spec. Measured on the MOTIR-1781 PR (Actions run `30651989797`):
a pure repo-provisioning card with no user-observable surface republished **seven**
already-accepted stories, with clips recorded off its branch that nobody watched. That
also contradicted `plan-rules.md` (MOTIR-1644), which scopes acceptance video to
user-facing stories.

**The rejected fix, and why.** "Publish only from `main`" is simpler and **breaks the
feature**. The acceptance gate is `acceptanceEvidenceService.decide()`: approve moves
the story `in_review → done`, and the workflow rejects it for a story that is not
`in_review`. `in_review` is the **PR-OPEN** state — the status sync flips the card to
`done` on MERGE. Publishing post-merge would land the receipt after the story was
already Done, so the reviewer would never get to watch-then-approve. MOTIR-1627 states
the intended timing directly: "when MOTIR-1627 is `in_review`, its acceptance panel
shows the video … and the story is accepted by watching its own video + Approve."

**The decision — OWNERSHIP, not branch.** A run publishes the receipts for the
acceptance specs **it changed**, and nothing else.

| Run                                              | Records + checks | Publishes                        |
| ------------------------------------------------ | ---------------- | -------------------------------- |
| PR that changes `tests/e2e/acceptance-X.spec.ts` | yes              | **only X's story**               |
| PR that changes no acceptance spec               | yes              | **nothing**                      |
| Push to `main`                                   | yes              | **nothing** (the PR already did) |

- The recording carries its producing spec in `recording-meta.json` (`specFile`), and
  CI passes the PR's changed acceptance specs; the uploader publishes a recording only
  when the two match.
- **The checks stay on every run.** Discovery, story resolution and the watchability
  floor (§2's amendment / MOTIR-1772) run regardless and report through the annotation
  - job-summary channels, including a non-zero exit for an unpaced clip. Deferring them
    to the owning run is the MOTIR-1905 blind spot, where a broken acceptance gate looked
    green for days.
- **Fails closed.** An empty or unset owned-set owns nothing, so a workflow edit that
  drops it rehearses rather than resurrecting the bug; likewise a recording whose
  sidecar carries no `specFile`.

**Deliberately unchanged:** eligibility (decision 1), retention/supersede semantics
(§2), the org toggle (§3), and the auth mechanism above. Distinct from MOTIR-1911 —
one clip exceeding the per-file cap is a size problem, not a question of which run
publishes. The starter's own acceptance lane is MOTIR-1941.

#### Amendment 2026-07-31 (Yue · MOTIR-1949) — the LANE is story-scoped too

The amendment above scoped the **publish** and kept the lane: "the checks stay on
every run". That half held for one day. It fixed the correctness bug (verified:
run `30673082674`, eight recordings, `rehearsed: … → MOTIR-811 … 0 published`) but
left the cost that started the whole thread — _why does every PR carry this check?_

**Measured, on a PR that publishes nothing** (same run): the `acceptance-video` leg
took **11 min**, the run's long pole (next longest 8 min), and uploaded a **419 MB**
report (every other leg ≤ 3 MB, retained 7 days) — to record eight clips and then
correctly discard them. Paid on every `subtask/*` PR and every push to `main`.

**The decision (Yue): the lane runs only for the PR that owns an acceptance spec** —
"no acceptance video step unless the PR is for story E2E test". This **supersedes**
"the checks stay on every run". The table above becomes:

| Run                                              | Lane runs   | Publishes                    |
| ------------------------------------------------ | ----------- | ---------------------------- |
| PR that changes `tests/e2e/acceptance-X.spec.ts` | yes         | **only X's story**           |
| PR that changes no acceptance spec               | **no lane** | nothing                      |
| Push to `main`                                   | **no lane** | nothing (the PR already did) |

- **Absent, not skipped — and only ONE mechanism achieves that.** The lane moves
  out of `ci.yml` into its own `.github/workflows/acceptance-video.yml` (RENAMED
  `acceptance-tests.yml` by MOTIR-4096 — the sentence records what MOTIR-1949
  did, and the mechanism it describes is unchanged), triggered
  by `on: pull_request: paths: ['tests/e2e/acceptance*.spec.ts']`. A workflow whose
  path filter does not match is never TRIGGERED, so no run exists and no check
  appears. The two cheaper-looking options were both tried and are both wrong:
  - a **matrix leg** cannot be dropped by an expression at all;
  - a **job-level `if:`** does not remove the check — a job whose `if:` is false is
    still reported as a greyed `Skipped`. Measured, not assumed: the first attempt
    at this card gated an `acceptance` job on a detector job's output, and PR #1751
    still listed `Playwright E2E (acceptance-video) · skipping`. Free in minutes,
    but still "the step is there", which is what was asked to go away.
- **What the separate workflow costs.** It cannot `needs:` ci.yml's `build` job or
  read that run's artifacts, so it compiles `.next/` itself (the shared
  `./.github/actions/e2e-setup` composite takes a `next-build: build` input for
  exactly this). That is one extra build, paid only on the PRs that own a spec —
  where the 11-minute lane dwarfs it. There is deliberately no `push:` trigger.
  **(Superseded 2026-08-17 by the MOTIR-2760 amendment below — there is now a
  `push: main` baseline, gated on the lane holding a spec.)**
- **What this costs, said out loud.** The watchability floor and story resolution
  (§2's amendment / MOTIR-1772, MOTIR-1905) now run **only on the owning run** — a
  spec that drifts below the floor is caught when its own PR next touches it, not
  on the next unrelated PR. That is the MOTIR-1905 blind spot re-accepted, at a
  much smaller radius: the gate reports on the run that can actually act on it.
  The acceptance specs also stop acting as incidental regression coverage on other
  PRs; the bulk / a11y / at-scale legs are the regression net.
- **Belt and braces.** The uploader still receives and filters on the owned set, so
  the correctness fix does not depend on the workflow gate being right.
- **⚠️ THERE IS NO `main` BASELINE FOR THIS LANE, AND THAT COSTS A DIAGNOSTIC
  (MOTIR-2506).** Because there is no `push:` trigger, `main` never runs the
  acceptance lane — so the standard flake-vs-regression discriminator every other
  check enjoys (`motir-core/CLAUDE.md`: _"the failure reproduces on `main` without
  your change"_) is **unavailable here, by construction**. When this lane goes red,
  reach for the substitutes instead: does the SAME test fail on a re-run of the same
  commit (a real defect) or a DIFFERENT one (the runner); do the other tests in that
  spec file pass (the seed and the boundary mocks are fine); and does the diff touch
  any surface the failing spec renders. The second consequence of the `paths:` filter
  compounds it — a PR adding ONE acceptance spec runs, and becomes answerable for,
  all of them. Budget for that when a story plans its acceptance E2E.
  **(Amended 2026-08-17 by MOTIR-2760: there IS a `main` baseline now, whenever the
  lane holds a spec — so the discriminator is available exactly when there is
  something to discriminate. It is still unavailable on an EMPTY lane, where by
  definition there is no red to diagnose.)**

The starter (MOTIR-1941) shipped this shape from day one; motir-core now matches it.

#### Amendment 2026-08-17 (MOTIR-2760) — the MAIN BASELINE: `push: main`, gated on membership

> **⚠️ Superseded on 2026-11-02 by the amendment that follows (MOTIR-9412 ·
> MOTIR-10277): the lane no longer runs on `push: main`; it runs nightly and on a
> manual dispatch.** This amendment stands as the record of why the per-merge
> baseline was chosen, including its rejection of a nightly, which the next one
> reverses.

The amendment above bought its cost saving with a blind spot it named honestly and
left open: the `paths:` filter cuts between an app change and the specs that read
it, so **an app change could break every acceptance spec, merge green, and wait on
`main` until an unrelated PR happened to touch a spec** — at which point that PR's
author inherited the diagnosis. Measured instance: MOTIR-2654 moved sign-in's
`callbackURL` to `/home`, `acceptance-ai-callout.spec.ts` broke at `c6b5d19d`, and
it surfaced on MOTIR-2664's PR (#2045), which does not own that spec. MOTIR-2620
had already declined to close it by widening the filter, and was right to.

**The decision: the lane also runs on `push: main`, but only while it holds a spec,
and a baseline run TESTS without ever PUBLISHING.**

| Run                                             | Lane runs         | Publishes   |
| ----------------------------------------------- | ----------------- | ----------- |
| PR changing an `acceptance*.spec.ts`            | yes (4 shards)    | that story  |
| PR changing a lane-definition file (MOTIR-2600) | yes (4 shards)    | nothing     |
| PR changing anything else                       | **no lane**       | nothing     |
| push to `main`, lane holds ≥ 1 spec             | yes (4 shards)    | **nothing** |
| push to `main`, lane empty                      | **gate job only** | nothing     |

**Why the gate is the load-bearing half, against this ADR's budget.** Measured on
run `31740853229` (the MOTIR-2765 merge, against an already-empty lane): `build`
6 min + four shards at 3 min = **18 machine-minutes to run zero tests**. The cost
is setup and a `next build`, not the specs, so it does not shrink with the lane.
`main` takes roughly 20 merges/day, so an ungated `push:` trigger would spend
**~360 machine-minutes/day** — and after MOTIR-2769's triage an empty lane is the
STEADY STATE, not an edge case. Gated, an empty lane costs one ~10-second checkout
per merge (~3 min/day), and the fan-out is paid only inside the window a story is
actually in review. That is the difference between this being affordable and not.

**Why not the alternatives**, all of which MOTIR-2760 was written to weigh and all
of which MOTIR-2765 re-priced:

- **Widening `paths:` to `app/**`/`lib/**`** — still rejected. MOTIR-2620's
  reason (the specs read most of the app) stands, and post-triage it is worse:
  widening would run an 18-machine-minute lane on nearly every PR to execute
  nothing at all.
- **A nightly run** — cheaper, but its red names a commit RANGE where the baseline
  names one merge, and attribution is the entire product here. On an empty lane it
  is also pure waste, which is most nights.
- **A cheap smoke subset on every PR** — there is no subset to take: the lane is
  usually empty and otherwise holds one or two specs.

**MOTIR-1949's requirement is untouched, and the reason is subtle enough to state.**
"Absent, not skipped" is a constraint about **pull requests** — a greyed check on
someone's PR. A `push` event attaches its checks to the commit on `main` and adds
nothing to any open PR, so the gate may skip freely there at no cost to anyone. On
`pull_request` the gate returns `true` unconditionally: the `paths:` filter has
already decided, and MOTIR-2600 deliberately wants a lane-definition PR to rehearse
against an empty membership. The gate also sits on `build` rather than on the shard
job, so `tests/ci-acceptance-lane.test.ts`'s assertion that the shard job carries no
job-level `if:` stays literally true.

**The baseline never publishes, via two independent mechanisms** — because the
failure mode is not a wasted run but a SUPERSEDED receipt (MOTIR-1937): the publish
step is `if:`-gated to `pull_request`, and the owned-specs step emits an empty list
on `push` (there is no base ref to diff), which the uploader already fails closed
on. The §4 rule that only the owning PR may publish is therefore strengthened, not
weakened: a merge is not a new moment to record.

**And `cancel-in-progress` becomes PR-only.** Cancelling a superseded run is right
for a PR and wrong for a baseline: back-to-back merges would cancel each other and
hand back exactly the ambiguity about _which merge broke it_ that this trigger
exists to remove.

**What is still deliberately not covered.** The PR that BREAKS a spec still goes
green; the baseline catches it one merge later. Closing that requires the widening
rejected above, so the accepted cost is a red `main` for the length of one fix —
bounded, attributed to the author who caused it, and no longer inherited by the
next passer-by.

#### Amendment 2026-11-02 (MOTIR-9412 · MOTIR-10277) — THE NIGHTLY replaces the `push: main` baseline

**The decision.** The run of the whole lane against `main` moves from every push to
`main` to a **nightly `schedule`** (03:17 UTC) plus a **manual `workflow_dispatch`**.
The nightly is now the baseline. `push: main` is no longer a trigger of
`.github/workflows/acceptance-tests.yml`, so a merge starts nothing in this
workflow. MOTIR-9412 decided it on its decision page; MOTIR-10277 built it.

**It reverses the 2026-08-17 amendment's rejection of a nightly, knowingly.** That
amendment rejected a nightly because its red names a commit RANGE where the
per-merge baseline names one merge, and because on an empty lane it is waste. The
second reason no longer holds: since MOTIR-9411 the same workflow runs the
regression lane, ~150 specs that are never empty, so a run against `main` costs a
full fan-out every time — 14 acceptance and 10 regression legs at today's
membership, a run merge-queue §9 measured at a median ~58 minutes — and `main`
takes ~20 merges a day. The first reason is true and is **the cost taken on**:

- **A break surfaces up to a day after it merges**, not on the merge that caused it.
- **Its red names a range** — every merge since the last green night — not one merge.

**What narrows the range.** A manual dispatch runs the whole lane at the head of a
branch or tag. GitHub's dispatch API takes a ref, not a sha, so bisecting means
pushing a branch at the commit being tried (`bisect/acceptance-<sha>`) and
dispatching on it. The concurrency group is keyed on the commit for every event but
`pull_request`, so dispatches at different commits run side by side, and
`cancel-in-progress` stays PR-only, so nothing cancels a nightly or a dispatch.

**A red night reaches a person, not a red check.** A scheduled run's red attaches
to a commit nobody is looking at — MOTIR-3850's scheduled lane was red for 17 days
and nobody was told. `.github/workflows/acceptance-nightly-notify.yml` runs on
`workflow_run` for this workflow and, for a SCHEDULED run that did not go green
(failed, cancelled, timed out, failed to start), opens ONE issue labelled
`acceptance-nightly-red`, assigned to the login named once in that file, with the
run and a compare link from the last green nightly's commit — or comments on that
issue while it is open. A green night tells nobody, and a red dispatch tells nobody:
whoever started it is watching. A person closes the issue.

| Run                                                | Lane runs          | Publishes   | Tells a person   |
| -------------------------------------------------- | ------------------ | ----------- | ---------------- |
| PR touching a lane path                            | yes (derived legs) | its story   | no               |
| PR touching nothing in the lane                    | **gate job only**  | nothing     | no               |
| queue entry (merge-queue §9: its own diff decides) | as for a PR        | nothing     | no               |
| nightly, lane holds ≥ 1 spec                       | yes (derived legs) | **nothing** | **if not green** |
| manual dispatch, lane holds ≥ 1 spec               | yes (derived legs) | **nothing** | no               |
| nightly or dispatch, lane empty                    | **gate job only**  | nothing     | no               |
| push to `main`                                     | **no run**         | nothing     | no               |

**What did not change.** The `membership` gate needed no new branch: a `schedule`
or `workflow_dispatch` event falls through to the membership count, so each lane
runs at its own derived legs when it holds a spec and an empty lane runs nothing.
The receipt still publishes only from a green `pull_request` run, by the same two
mechanisms (the step's `if:` and the empty owned-spec list on a run with no PR
base). MOTIR-1949's "absent, not skipped" constraint is about pull requests and is
untouched by a scheduled run.

**Still not covered:** the PR that breaks a spec still goes green, and so does its
queue entry. The nightly finds it, a day later at most.

#### Amendment 2026-08-10 (MOTIR-2600) — the lane is SHARDED, and it triggers on its own definition

> ⚠️ **Superseded in part by the 2026-09-01 amendment (MOTIR-4096): the CI
> uploader this section reasons about no longer exists.** The reasoning is kept
> as the record of why the lane is shaped the way it is; the files it names
> (`scripts/upload-acceptance-video.mjs`, `tests/acceptance-video-uploader.test.ts`,
> the publish step) are retired, and the lane is now
> `.github/workflows/acceptance-tests.yml`.

Two clauses of the amendment above are superseded in shape, not in principle. Both
changes are structural; nothing about who may publish, or when, moves.

**1 · One serial job becomes one build + four sharded legs.** The lane ran
`workers: 1` over every acceptance spec and was lengthening with each story that
added one — **22.2 → 23.1 → 26.7 → 29.1 minutes** across the runs on record. It now
runs `--shard=i/4` on four legs, with `.next/` compiled ONCE in this workflow's own
`build` job and downloaded by each leg. (The "it compiles `.next/` itself" clause
above still holds for the WORKFLOW — it just no longer holds four times: a workflow
cannot read another workflow's artifacts, but it can read its own run's.)

Measured against the real per-test durations of run `31387950195`, whose 73 tests
sum to 25.7 min: the four legs are **8.0 / 8.9 / 4.6 / 4.2 min** of test time, so
the long pole is ~9 min plus ~2–3 min of setup — comfortably inside the ~15 min
this card asked for, and one build instead of four.

**⚠️ The parallelism is the easy half; the receipts are the load-bearing half.**
Publishing SUPERSEDES a story's current evidence, and the publish step has already
been the source of two separate defects (MOTIR-1734: one clip per run; MOTIR-1937:
every PR republishing unrelated stories). Split N ways, each leg holds a DIFFERENT
subset of the videos. **Every receipt still publishes exactly once, by construction
rather than by coordination** — which is why each leg keeps its own publish step
instead of a fan-in job collecting gigabytes of video:

- `--shard` PARTITIONS the suite (Playwright keeps a spec FILE whole within one
  leg), so a recording exists in exactly ONE leg's output dir, and the uploader
  publishes what it finds there;
- ownership is per RECORDING, not per run — `isOwnedRecording` matches the
  recording's own `specFile` sidecar against the changed-spec list — so a leg that
  ran none of the changed specs finds nothing owned, logs "Nothing to publish", and
  exits 0 rather than failing for a receipt that is another leg's to write.

Both halves are asserted against the uploader itself, over two shard-shaped output
dirs, in `tests/acceptance-video-uploader.test.ts` (`across shards`); the workflow
half is in `tests/ci-acceptance-lane.test.ts`. Each leg also uploads its report
under a shard-scoped artifact NAME — `upload-artifact` v4+ rejects a duplicate, so
one name would have cost the lane three of its four reports.

**2 · The lane's own definition is a trigger.** `paths:` was the spec glob alone,
so a PR that RESTRUCTURED the lane — the workflow, the Playwright config, the
fixture harness — changed no acceptance spec and never ran it. Those four paths are
now triggers too. This does not weaken the requirement above (a PR that does not own
an acceptance spec shows no acceptance check): an ordinary PR matches none of them,
and a PR that matches only them changes no spec, so the run REHEARSES — it records
and checks every clip and publishes nothing, exactly as MOTIR-1937 specified.

**3 · A red lane now leaves the client's own account of the failure.** Independent
of sharding, and the reason MOTIR-2600 exists: the lane's failures surface as a
locator that found nothing, several steps downstream of whatever went wrong, and the
`⚠️ THERE IS NO main BASELINE` note above says why that is expensive here. Every
failing test in this lane now attaches a `client-diagnostics.json` — the console,
the page errors, the request ledger, and the renderer's own idle time — carrying a
one-line verdict that separates _the page threw_, _a request failed_, _nothing was
in flight_ and _the page was genuinely still working_. The first three were
indistinguishable before, which is how the same red check got two opposite verdicts
on consecutive runs of one PR.

#### Amendment 2026-08-11 (MOTIR-2646) — the lane also SAMPLES, on every run

Clause 3 above fires only when a test fails, and that turned out to be the binding
limit rather than a detail. MOTIR-2621 read one of those captures and closed the
diagnosis — the stall is not a route's defect, it landed on a public docs page with
no session and no planning code — and then asked for a remedy proposed against the
LANE. The census is 2 occurrences in 57 runs. **A ≈3.5 % binary event cannot be
A/B'd**: detecting even a halving needs on the order of a hundred runs per arm, so
every card shaped as _change the lane, then prove it helped_ is unbuildable, and
every card that skips the proof is a guess.

So the lane now measures the CONDITION instead of waiting for the event. The same
renderer signals the failure report reads once are read on **every navigation of
every run**, and written to a `contention.json` sidecar beside `chapters.json`: the
per-navigation idle gap, the windowed Long Tasks reading, and the round-trip latency
of the probe itself (a renderer that will not answer a trivial `evaluate` is the
failure, sampled continuously). The shaping is pure and gated —
`tests/e2e/_helpers/acceptance-diagnostics.ts`, same module and same coverage floor
as the verdict — and the fixture that feeds it is next door.

**Two constraints this amendment does NOT relax**, both from §2's watchability rule:

- **The lane stays a RECEIPT, not an alarm.** Sampling adds no assertion. A slow
  navigation is recorded, never failed, and the budget above is untouched.
- **It costs a passing run nothing.** Every drain runs concurrently with a hold the
  lane was already taking, under a budget strictly below `CHAPTER_HOLD_MS`, so the
  hold is what times it out. A measurement that changed the pace would be worse
  than no measurement — the pace IS the product here.

⚠️ **Read the idle gap's TAIL, not its centre.** Those same deliberate holds are
stretches of nothing, so a healthy recording's median idle gap is a reading of the
hold schedule. The long-task and probe-latency signals carry no such contamination.

#### Amendment 2026-08-17 (MOTIR-2908) — the fan-out is SIZED to the lane, not fixed at four

Clause 1 of the MOTIR-2600 amendment is superseded in its NUMBER, not in its shape.
The lane still runs one `build` plus N sharded legs; N is no longer the literal `4`.

**Why the number moved without anyone touching it.** `4` was sized against the lane
as it stood on 2026-08-10: **26 specs, 25.7 minutes of test time**, lengthening with
every story that added one. Six days later MOTIR-2765 made an acceptance spec a
**receipt with a lifecycle** and MOTIR-2769 triaged every existing member out of the
lane. The lane's steady-state membership is now **zero**, and its ceiling is "the
stories currently in review" — realistically one or two. Nothing about that
invalidated MOTIR-2600's engineering; it invalidated the input MOTIR-2600 was
correct about.

**Why the leftover legs are not free.** A leg's cost in this lane is almost entirely
SETUP — a checkout, a Postgres container, a Playwright install, a build-artifact
download — roughly **3 machine-minutes before it looks at a spec**. Measured on run
`31740853229` (the MOTIR-2765 merge, an already-empty lane): `build` 6 min + four
legs at 3 min = **18 machine-minutes to run zero tests**. Three of those legs drew
no specs at all. `--pass-with-no-tests` (MOTIR-2769) is what made that state LEGAL,
and therefore invisible: the lane was green, and fast in wall-clock terms, while
being expensive in machine terms.

It also stopped being a PR-only cost. MOTIR-2760's `push: main` baseline means the
fan-out is paid **per merge** for as long as a receipt window is open. That card
bounded _when_ the lane runs; this one bounds _what a run costs_.

**The derivation**, computed by the `membership` gate that already counts the lane:

```
legs = min(specs, 4), floored at 1
```

| specs in the lane        | legs | machine-minutes (6 min build + 3 min/leg) |
| ------------------------ | ---- | ----------------------------------------- |
| 0 (a lane-definition PR) | 1    | 18 → **9**                                |
| 1                        | 1    | 18 → **9**                                |
| 2                        | 2    | 18 → **12**                               |
| ≥ 4                      | 4    | 18 → **18** (unchanged)                   |

Two bounds, each protecting something a plain "one leg per spec" would break:

- **The CAP keeps MOTIR-2600 whole.** At ≥ 4 specs the matrix is exactly the
  `[1, 2, 3, 4]` that amendment measured, so a lane that legitimately fills up
  again gets the parallelism it was sized for and never regresses toward the serial
  runtime it replaced.
- **The FLOOR of 1 keeps the rehearsal.** A PR that only restructures the lane runs
  no tests either way — what it still proves is that the harness BOOTS (the
  Playwright config loads, the webServer comes up, `e2e-setup`'s download path
  works). Zero legs would prove nothing, on precisely the PRs whose subject is this
  lane.

**Nothing about publishing moves, and the reason is that the exactly-once argument
never mentioned four.** `--shard` partitions the suite at any N, and ownership is
decided per RECORDING (`isOwnedRecording` against the changed-spec list) rather than
per run — so each leg still holds a disjoint subset and the subsets still cover it.
The distinct-artifact-name requirement survives for the same reason: `matrix.shard`
is `1..N`, distinct within a run at every N.

**Mechanically**, the gate re-exports two job outputs — `shards` (a JSON array the
matrix reads through `fromJSON`) and `legs` (the same number as a scalar, used for
the `--shard=i/N` denominator and the job name) — and the shard job gains a second
`needs:` edge to `membership`, because a job can only read the outputs of a job it
needs. That edge adds no gating: `membership` always runs, and the MOTIR-2760 skip
still arrives through `build`. The shard job still carries no job-level `if:`, so
MOTIR-1949's "absent, not skipped" requirement is untouched.

**Asserted by EXECUTING the gate, not by describing it** — `tests/ci-acceptance-lane.test.ts`
extracts the step's `run:` block from the workflow and runs it under `bash` against
a fabricated lane of 0 / 1 / 2 / 3 / 4 / 9 / 26 specs, reading back what it writes to
`$GITHUB_OUTPUT`. A text assertion is the right tool for a `needs:` edge and the
wrong one for arithmetic: a regex that agrees with the derivation agrees just as
happily with an off-by-one, and the floor and the cap are exactly where one would sit.

#### Amendment 2026-08-23 (MOTIR-3408) — a REFUSED artifact takes the same per-artifact rule as an OVER-CAP one; recovery needs no new CI surface

MOTIR-1911's amendment above settled what happens when an artifact is **too
big**: the video is the receipt so an over-cap video fails the step, and the
trace is a debugging aid so an over-cap trace is _dropped_ and the video
publishes without it. That rule was written on the SIZE axis and stops there.
**On the REFUSAL axis the code does the opposite**, and MOTIR-3313 is what that
costs.

##### What the refusal path actually does

In `scripts/upload-acceptance-video.mjs`, `uploadAcceptanceVideo` runs
`putSignedArtifact('video', …)`, then `putSignedArtifact('trace', …)`, and only
then POSTs the register call that writes the evidence row. `putSignedArtifact`
throws once its bounded retry is exhausted, so a refused **trace** propagates out
**before the register POST** — no evidence row is written at all, and the video's
bytes, which uploaded successfully seconds earlier, sit orphaned in the store.

So one artifact, two failure modes, opposite outcomes:

| the trace is…             | today                                                            | MOTIR-1911's stated reason                                                      |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **over the per-file cap** | dropped; the **video publishes**; warning; step green            | "the trace is a debugging aid"                                                  |
| **refused by the store**  | the **whole recording is lost**; step red; the video is orphaned | — none; the ordering was never decided, it is where the `throw` happens to land |

The observed incident is exactly the second row: every test passed, the store
answered one trace PUT with `503 SlowDown`, and MOTIR-3232 was left holding one
of its two receipts.

##### Decision — D: extend the per-artifact rule to the refusal axis

**A trace that is still refused after `putSignedArtifact`'s retries is DROPPED,
exactly as an over-cap trace is: the video's receipt is registered without it,
the drop is reported as a `warning` annotation and in the job summary, and the
step stays green.** A refused **video** is unchanged — it fails the step, because
there is nothing to fall back to.

This is not a new policy. It is MOTIR-1911's rule applied on the axis it was
never written for, and its own sentence is the argument: _"Costing a story its
evidence to save an attachment nobody accepts a story on is the bug, not the
fix."_ That is as true of a refusal as of a byte count.

##### Why this does NOT "make a partial publish green"

MOTIR-3313 is emphatic that `Published N of M owned acceptance recording(s)` and
the red check must both survive, because they are what made anyone look. They do,
and the distinction is exact: **that count counts RECORDINGS, not files.** Under
this amendment no recording is lost, so the honest count is `2 of 2` and there is
nothing for a red check to report — while a lost _recording_ still reddens the
step exactly as before, on either artifact.

The counter-argument is worth recording rather than waving past: a `warning`
annotation is a weaker signal than a failed job, and this incident was found
_because_ someone looked at red. Two things answer it. The ADR already accepted
that trade on the size axis and has lived with it since 2026-08-04. And the
alternative it is weighed against is not "a louder signal" but "a lost receipt" —
reddening the lane did not save MOTIR-3232's clip, it only announced the loss.

##### The recovery question — measured, and it needs no new CI surface

MOTIR-3313 also asked whether a partial publish should be recoverable _without
re-running six minutes of browser tests to move two files_. It is, and the bytes
were already there the whole time.

**Read from the incident's own artifact** — `playwright-report-acceptance-video-shard-2`
of run `32435341259` (artifact id `9430776431`, 210,446,383 B, still unexpired at
the time of writing):

```
gh api repos/moooon-B-V/motir-core/actions/artifacts/9430776431/zip > shard2.zip
unzip -l shard2.zip     # 43 files
```

- The layout is **flat and content-addressed**: `data/<sha1>.<ext>`, plus
  `index.html` and the `trace/` viewer bundle. No directory per test, and no
  original filenames.
- **Every input the publish needs is present.** Per recording: `video` (`.webm`),
  `trace` (`.zip`), and the three sidecars `acceptance-story`, `chapters` and
  `recording-meta`, each registered as a Playwright attachment by
  `tests/e2e/_helpers/acceptance-video.ts` and carried through by the HTML
  reporter.
- **The recording → attachment mapping is recoverable**, from the report's own
  manifest: `index.html` carries `<meta id="playwrightReportBase64">` holding a
  `data:application/zip;base64,…` payload whose per-test JSON entries each carry
  an `attachments` array of `{name, contentType, path}`, where `path` is the
  `data/<sha1>.<ext>` key.
- **The manifest is not optional.** Content addressing DEDUPLICATES identical
  files, and both MOTIR-3232 recordings declare the same story, so
  `{"storyKey":"MOTIR-3232"}` is stored **once** for **two** recordings. A naive
  scan of `data/` therefore cannot reconstruct the recording set, and would
  mis-attribute it if it tried.

Reconstructed from that manifest, the run held:

| story          | spec                                       |  video |   trace |
| -------------- | ------------------------------------------ | -----: | ------: |
| **MOTIR-2999** | `acceptance-implemented-lifecycle.spec.ts` | 2.6 MB | 45.6 MB |
| **MOTIR-3232** | `acceptance-plan-shapes.spec.ts` (REFUSED) | 2.1 MB | 45.9 MB |
| **MOTIR-3232** | `acceptance-plans-surface.spec.ts`         | 4.3 MB | 89.3 MB |

##### ⚠️ Correcting MOTIR-3313's figures — its conclusion holds, its numbers were local

The card reports the refused trace at **37.0 MB** and the one that succeeded
seconds later at **65.8 MB**. Those came from regenerating both recordings
locally; the numbers above are the bytes CI actually uploaded, and they are
larger — **45.9 MB refused, 89.3 MB accepted**. Recorded here rather than
silently replaced, because the discrepancy has a mundane cause (a local run is
not the CI run) and could otherwise be re-derived as drift.

**The card's conclusion survives the correction and is strengthened by it: the
REFUSED artifact is still much smaller than one the same job accepted moments
later, on the real bytes rather than on a local proxy.** Worth noting in passing
that 89.3 MB is within 11% of the 100 MB per-file cap — not a factor in this
incident, which the store refused rather than the cap rejected, but the margin is
thinner than the ADR's envelope suggests.

##### Not chosen, and why

- **C · Upload `out/playwright-output-acceptance` as its own artifact.**
  **Rejected on measurement.** The report artifact already carries every byte —
  all three videos and all three traces, 210 MB for this shard. A second upload
  would duplicate ~180 MB per shard per run to obtain files that are already
  retained for the same seven days.
- **B · A `workflow_dispatch` re-publish job over the retained artifact.**
  **Rejected for now, and this reverses the recommendation MOTIR-3408 was
  authored with** — on evidence that card did not have, since the artifact had
  not been opened when it was written. With D in place the observed failure class
  loses nothing, so B's remaining scenario is a refused **video**: four
  consecutive retry failures on a 2–4 MB body, against traces that are twenty
  times larger. Building a dispatch entry point plus a manifest reader to save six
  minutes on that is machinery ahead of its need.
  **What reopens it, stated so the next reader does not re-argue it: any refused
  VIDEO, or a second lost recording of any kind.** Either is evidence the rate is
  not what this assumed.
- **A · Re-run the lane** remains the fallback for that residual case, at the cost
  of one build plus one shard's browser run.

##### The manual recovery path, which exists today

Because the bytes and the mapping are both in the retained artifact, a lost
receipt can be republished **with no code change and no browser run**. This was
not reasoned — it was **performed**, against the incident's own artifact:

1. Reconstruct one directory per recording from the manifest, naming each file so
   the suffix match in `findRecordings` sees it — `*.webm`, `*trace.zip`,
   `*chapters.json`, `*recording-meta.json`, `*acceptance-story.json`.
2. Run the SHIPPED library over it. `findRecordings` returned all three
   recordings intact, and `resolveOwnedSpecs` / `isOwnedRecording` selected
   exactly the one whose trace was refused:

   ```
   findRecordings -> 3 recordings
     storyKey=MOTIR-2999 | spec=acceptance-implemented-lifecycle.spec.ts | owned=false | video=yes trace=yes chapters=yes
     storyKey=MOTIR-3232 | spec=acceptance-plan-shapes.spec.ts           | owned=true  | video=yes trace=yes chapters=yes
     storyKey=MOTIR-3232 | spec=acceptance-plans-surface.spec.ts         | owned=false | video=yes trace=yes chapters=yes
   ```

   (`owned` computed with `ACCEPTANCE_CHANGED_SPECS=tests/e2e/acceptance-plan-shapes.spec.ts`.)

3. Publish: `node scripts/upload-acceptance-video.mjs` with
   `ACCEPTANCE_OUTPUT_DIR` pointing at the reconstruction and
   `ACCEPTANCE_CHANGED_SPECS` naming the spec(s) — it **fails closed** on an empty
   value, so that must be set. Auth is the `MOTIR_UPLOAD_TOKEN` `integration` PAT,
   since keyless OIDC is only available inside CI.

Step 3 was deliberately NOT executed here: MOTIR-3232 already holds both receipts
(a fresh run republished them on 2026-08-21), and publishing is
supersede-on-create — re-running it would retire a good receipt to prove a point.
Steps 1–2 are what the feasibility turned on, and they are what was run.

##### What this amendment does NOT settle

**Why the store refused that write is still unknown**, and nothing above depends
on it. Three explanations were falsified by measurement on MOTIR-3313 and the
readings here falsify none of them further; the question is being put to the
provider out of band (MOTIR-3407), because Tigris exposes no request-log API and
`fly storage` has no logs command. **Every decision in this amendment is owed
whatever that answer turns out to be** — a body of tens of megabytes over the
public internet is not a reliable single-shot operation under any explanation.

---

## Consequences

- **MOTIR-1629** adds `AcceptanceEvidence` (one current per story, supersede
  semantics), `AttachmentSource.acceptance_video`, and a **gated** video MIME
  allowlist (video accepted only on the acceptance path; the generic editor
  upload still 415s a video). `AcceptanceEvidence` is workspace-scoped →
  `workspaceId` column + RLS in the same migration; every FK modelled as a
  Prisma `@relation`.
- **MOTIR-1630** adds `Organization.acceptanceVideoEnabled` (default `true`) and a
  single `acceptanceVideoEligibilityService` encoding the decision-1 table
  (`hasPaidAiPlan && toggle`, `applicable:false` short-circuit); every acceptance
  membership/write path must consult it (the "new access gate → sweep all
  creators" rule).
- **MOTIR-1631** adds `POST` publish (integration-scope auth) that runs eligibility
  - `resolvePerFileLimitBytes` + `assertWithinStorageCap` before creating evidence,
    returning 402 (no plan) / 403 (toggle off / not admin-configured) / 413 (over
    per-file cap) as distinct signals the panel can render.
- **MOTIR-1632** pins the Playwright `use.video` size/duration budget and ships a
  reusable uploader the acceptance E2E (and the self-test dogfood run) call.
- **Keyless follow-up (2026-07-06 amendment, MOTIR-1648):** **MOTIR-1650** adds
  the GitHub-OIDC auth path on the publish endpoint (`lib/github/oidcAuth.ts` →
  verify JWKS + `repository` claim → resolve `GithubInstallation.workspaceId`,
  PAT retained as fallback); **MOTIR-1651** updates the BYOK docs + uploader
  Action to keyless (drop `MOTIR_UPLOAD_TOKEN` for App-connected repos, PAT as
  fallback). No change to the eligibility / cap / record flow.
- **Retention** rides the existing orphan-GC — no new GC job. **Plan lapse** needs
  no pruning code (evidence is left read-only).
- **Self-host / meta** never see a gated surface (eligibility=false via
  `applicable:false`), so the feature is a clean no-op off-cloud.
- **Out of scope / hand-off:** Epic 9 owns the hosted video-delivery variant; the
  planner-rule change (teach every story's E2E to emit acceptance video —
  `plan-rules.md` + motir-ai `SHARED_PLANNING_RULES`) is a separate motir-meta/-ai
  follow-up tracked outside this motir-core story.
