# ADR: The acceptance-receipt lifecycle — a receipt is a test EXECUTION, the spec is a TEST, and a design result is neither

- **Status:** Accepted (2026-08-13, drafted for Story MOTIR-2765 per the
  decision-subtask ladder). This is the rung-1 policy the rest of MOTIR-2765
  implements — no lane, guard or publisher change ships until these six
  decisions are pinned. **No application behaviour ships in this subtask** (the
  ADR only, plus the one-line pointer §5 owes its sibling record).
- **Story / Subtask:** MOTIR-2765 (An acceptance spec is a RECEIPT, not a
  regression test — it should record once, freeze on approval, and then leave
  the lane) · Subtask MOTIR-2767.
- **Consumed by:** MOTIR-2768 (the publisher's skip), MOTIR-2769 (the triage of
  the specs already in the lane), MOTIR-2770 (the lane-membership guard),
  MOTIR-2771 (the integration test over the freeze seam), MOTIR-2772 (the
  author-facing documentation).
- **Builds on:** `acceptance-video.md` (the pipeline this governs — entitlement,
  supersede/retention, keyless CI auth) and `design-result.md` (§2 and §4, the
  premises §5 rests on).
- **Ships FIRST and independently:** **MOTIR-2764** — the service-level refusal
  to supersede an `approved` receipt. That is the data-loss fix; it must not
  wait for this record, and this record does not own it. §4 states where it sits
  in the layering.
- **Supersedes / superseded by:** none. It is the authority for the receipt's
  LIFECYCLE; `acceptance-video.md` remains the authority for the pipeline that
  produces one.
- **Amended:** 2026-09-21, **AMENDMENT 1** (MOTIR-5872) — approval PINS the
  recording and moves the story; it does not freeze the story, and it does not
  evict the spec. **§2's `approved → REFUSED` row, §3's trigger, §4's layers 1
  and 3, and §6 are superseded by it** — read it before those sections.
  2026-10-24, **AMENDMENT 2** (MOTIR-9411) — a third route, **MOVE**, into the
  regression lane that keeps the acceptance lane's triggers. **§3's two-route
  table is widened by it.**

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `acceptance-video.md` / `design-result.md`): a decision
> record is a markdown file under `docs/decisions/`, structured **Status →
> Context → Decision → Consequences**, with the load-bearing facts pinned in
> explicit tables so downstream code has one authoritative source to implement
> against.

---

## Context

An acceptance video records a **moment**: the story was implemented, and here is
a person watching it work. Motir's acceptance gate rests entirely on that claim —
a story is not done because a checkbox says so, it is done because there is a
recording and somebody watched it.

The implementation treats the spec that produces the recording as a permanent
fixture of the repository: re-run and re-published forever, with no route out.
Those are two different things, and every cost below follows from conflating
them.

### The entity split this is missing, by name

Every mature test-management tool separates two entities Motir has fused into
one:

| Entity             | What it is                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| **Test**           | Reusable, maintained, versioned. Asserts what must **stay** true.         |
| **Test Execution** | The record of ONE run, at one moment, against one version. **Immutable.** |

Xray models both as distinct Jira work-item types — Tests, Test Sets, **Test
Executions** and Sub Test Executions — versioning the Test while the Execution
stands as the historical record. Zephyr exposes only Tests, with executions in a
1-1 relationship and no version control, and is the weaker model for exactly
this reason.

**Motir has the Test and calls it the Execution.** `acceptance-*.spec.ts` is a
Test: it lives in the repo, runs in CI, is maintained. The video it publishes is
an Execution: a receipt for a moment. Because there is only one entity,
re-running the Test rewrites the Execution.

### Shipped substrate this reconciles against (verified 2026-08-13 on `origin/main` @ `fca2c9f3`)

| Fact                                                                                                                                    | Where                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The status enum already distinguishes the three states — `pending` · `approved` · `changes_requested`                                   | `prisma/schema.prisma` (`enum AcceptanceEvidenceStatus`)                                                            |
| **The supersede path never reads it** — `updateMany({ where: { workItemId, isCurrent: true } })`, no status predicate                   | `lib/repositories/acceptanceEvidenceRepository.ts` (`markSupersededByWorkItem`)                                     |
| Superseded evidence is **unlinked**, so the orphan-GC reclaims the blob after the safety window                                         | `lib/services/acceptanceEvidenceService.ts` (the record path)                                                       |
| Approval is the IN-REVIEW gate: a story is approved out of review, never out of `todo` or mid-implementation                            | `lib/acceptanceEvidence/errors.ts` (`AcceptanceEvidenceNotInReviewError`)                                           |
| One current receipt per story, enforced by a **partial unique index**, not by the service                                               | `acceptance_evidence_one_current_per_story`                                                                         |
| Lane membership is a GLOB, and the two configs are complementary — membership is decided by the FILENAME alone                          | `playwright.acceptance.config.ts` (`testMatch: ['**/acceptance*.spec.ts']`) · `playwright.config.ts` (`testIgnore`) |
| A spec declares its story through a fixture that writes a sidecar the uploader reads                                                    | `tests/e2e/_helpers/acceptance-video.ts` (`acceptanceStory()` → `acceptance-story.json`)                            |
| The lane is `pull_request`-only and `paths:`-filtered to the spec files — deliberately, so a PR that owns no spec grows no greyed check | `.github/workflows/acceptance-tests.yml` (MOTIR-1949 / MOTIR-1958; renamed by MOTIR-4096)                           |
| **"THIS LANE IS THE RECEIPT LANE, NOT A REGRESSION GATE"** — already decided, in the workflow's own header                              | same file (MOTIR-2620)                                                                                              |
| The publish step carries no `continue-on-error`; the uploader's exit code is the signal                                                 | same file (MOTIR-2499)                                                                                              |
| The lane holds **26** `acceptance*.spec.ts` at this commit                                                                              | measured — `ls tests/e2e/acceptance*.spec.ts \| wc -l`                                                              |

### What the conflation costs, all three observed

1. **False red on unrelated PRs.** MOTIR-2654 moved the sign-in landing.
   `acceptance-ai-callout.spec.ts` — the receipt for MOTIR-1342, accepted long
   ago — went red. Nothing regressed; the world moved on, and a historical
   assertion cannot tell the difference. It was "fixed" (motir-core#2051) by
   editing the receipt to describe today, which is not a thing a receipt should
   ever need.
2. **Destroyed approvals.** Re-publishing overwrites an `approved` receipt with
   a `pending` re-recording and schedules the approved video's bytes for
   collection. **Owned by MOTIR-2764, not by this record** — it ships first and
   alone.
3. **Permanent, growing cost.** 26 specs × 4 shards × ~12 min with `video: 'on'`
   - `trace: 'on'`, on every PR that touches any spec. Every story that ships
     adds one; none retires.

The tell is worth stating plainly, because it explains why more discipline is
not the fix. A spec for an accepted story went red, and the reflex was to update
the assertion so CI would pass. That reflex is right for a regression test and
exactly backwards for a receipt: it edits history to agree with the present.
Nobody was careless — the system offered no way to say _"this assertion was true
then, and its being false now is not a defect"_, so the only available move was
to make it true again. Everything about a spec's FORM says regression test: it
lives in `tests/`, it runs in CI, it has assertions. Only its PURPOSE says
otherwise, and purpose was enforced by nothing, so the form won.

---

## Decision

> ⚠️ **§2, §3's trigger, §4 and §6 below are AMENDED — see AMENDMENT 1 at the end
> of this section.** They are kept as the record of what was decided on
> 2026-08-13.

### §1. The two entities, and which one Motir stores

**A receipt is a test EXECUTION. The spec is a TEST. Their lifetimes are
independent.**

| Entity                           | Motir's representation                                          | Lifetime                                                                   |
| -------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Test** — the acceptance spec   | `tests/e2e/acceptance-<area>.spec.ts`, a file in the repository | Has a **lifecycle**: authored → records → discharged → promoted or retired |
| **Test Execution** — the receipt | An `AcceptanceEvidence` row + its video/trace attachments       | Fixed to a **moment**; immutable once signed (§2)                          |

The consequence that matters, and the one the code does not currently express:
**the execution's lifetime does not follow the test's.** Deleting a spec must not
delete the receipt it produced, and re-running a spec must not be able to rewrite
a receipt that has been signed.

- **Rejected: keep one entity and version it.** Storing every recording as a
  revision of one artifact and letting the panel pick "the approved one" leaves
  the destructive path in place and merely adds a selector on top of it. The
  history rows already exist; what is missing is not versioning, it is a rule
  about which row may be written.
- **Why the precedent matters.** This is not a novel model to defend from first
  principles — it is the standard one. Naming Xray means the next reader can
  check the shape against a tool they may already know, rather than against
  this document alone.

### §2. The freeze point is APPROVAL, not first recording

**While a story is `in_review`, re-recording is CORRECT. The moment someone
approves, the receipt is immutable.**

| Current receipt status | A new publish for that story                    | Why                                                                             |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| _(none)_               | **Records** it                                  | The first receipt.                                                              |
| `pending`              | **Supersedes** it                               | The reviewer has not signed; they must see current truth, not a stale clip.     |
| `changes_requested`    | **Supersedes** it                               | The whole point of requesting changes is that the next run should differ.       |
| `approved`             | **REFUSED** — nothing written, nothing unlinked | The signature is on THIS recording. There is nothing left for a rerun to prove. |

`approved` is the signature because approval is where a human's judgement enters
the record, and the enum already marks it. The gate is stated at the service
boundary (§4), so it holds for every caller — CI, a manual republish, a backfill.

- **Rejected: freeze on FIRST publish.** It would pin a receipt from a run the
  reviewer then rejected, which is the opposite of evidence — and it would make
  `changes_requested` unreachable in practice, since the re-recording it exists
  to invite could never land.
- **Rejected: freeze when the story reaches `done`.** Nearly right, and wrong at
  the edge that matters: a story can reach `done` without an acceptance video at
  all, and the enum — not the work item's status — is what records whether a
  human actually watched something. Keying the freeze off the receipt's own
  status keeps the rule about the receipt.

### §3. What a frozen receipt means for the spec — promote or retire, and there is no third option

Once a receipt is frozen, the spec that produced it **has discharged its
purpose** and must leave the acceptance lane by exactly one of two routes:

| Route       | What it means                                                                                                                                                                  | Choose it when                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PROMOTE** | Rename out of the `acceptance*` prefix so the main lane's glob picks it up. Strip `chapter()` / `beat()` / `acceptanceStory()` and the pacing holds. **Keep every assertion.** | The flow is worth protecting on **every** PR — which is what the main lane does and what this lane deliberately does not.                                               |
| **RETIRE**  | Delete the spec, **citing where the flow stays covered**.                                                                                                                      | The receipt exists and the coverage lives elsewhere. Worked example: `acceptance-ai-callout.spec.ts`, whose twin `ai-callout-gate.spec.ts` already rides the main lane. |

**Neither route is "delete the coverage".** The choice is which lane owns it,
made deliberately once. A retire that cannot name where the flow remains covered
is a coverage regression wearing a cleanup's clothes, and must become a promote.

**A spec whose story is still in review stays exactly where it is.** It has not
earned a disposition; moving it would break the receipt it is still producing.

- **Rejected: a third "leave it for now" state.** That state is the defect. It
  was never chosen by anyone — it was the silent default, twenty-six times.
- **Rejected: auto-deleting a discharged spec.** The disposition is a judgement
  about coverage that only a person holds. Automation that deleted specs on
  approval would silently drop regression coverage nobody meant to lose; §4's
  guard therefore FORCES the decision without MAKING it.

### §4. Enforcement is layered, and each layer does a job the others cannot

| Layer                                                                 | Card           | What only it can do                                                                                                   |
| --------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| **1. The service refuses** to supersede an `approved` receipt         | **MOTIR-2764** | Makes the data **undestroyable by any caller**. The floor. Ships first, alone, without waiting for this record.       |
| **2. The publisher skips** on that typed refusal, exits 0, says so    | MOTIR-2768     | Makes the refusal **legible** — a run log a person can read, instead of a mystery non-2xx reddening a finished story. |
| **3. The repo guard fails** on a spec whose story is already accepted | MOTIR-2770     | **Forces a decision** rather than permitting drift. The only layer that converts an omission into a prompt.           |

The layering is not redundancy. Layer 1 cannot ask anyone to triage a spec;
layer 3 cannot stop a byte being deleted; layer 2 is the only one that turns
either into something a human sees. Each catches what the one before it cannot.

- **Rejected: convention alone (a documented rule, no enforcement).** This
  defect **is** a convention that decayed. The lane's own header has said
  "receipt lane, not a regression gate" since MOTIR-2620, and twenty-six specs
  accumulated anyway. A rule that nothing checks is a rule that describes what
  people would have done if they had remembered.
- **Rejected: layer 3 alone (guard, no service refusal).** A guard fires in a
  PR; the destruction happens in a publish. The guard would prompt the triage
  and the receipt would still be gone.
- **Ordering is load-bearing.** Layer 3 turns on only after MOTIR-2769 has
  cleared the backlog. A guard shipped against two dozen accepted-story specs
  red-lights the branch on day one and gets reverted within the hour — after
  which it is remembered as the thing that broke the build.

### §5. A DESIGN RESULT IS EXPLICITLY NOT FROZEN

**Acceptance receipts are signed-and-frozen. Design results are
superseded-by-design. Same storage shape, opposite lifecycle.**

The design-result surface (MOTIR-2664) was built by reusing this pipeline, so it
shares the shape exactly: one current row per subject, a partial unique index,
history rows kept, supersede on publish, orphan-GC on the unlinked blobs
(`design-result.md` §4). A reader who finds this ADR and then reads that code
will see the same structure and reasonably ask whether the freeze applies.

**It does not, for a reason not visible from the code:**

|                  | Acceptance receipt                                                | Design result                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval gate    | **Yes** — `AcceptanceEvidenceStatus.approved`, stamped by a human | **None.** `design-result.md` §2 gates nothing and defines no status enum; the only "approval" in that record is the _separate_ runtime design-approval gate of Story MOTIR-693 (§7), which is not a property of the artifact |
| Therefore        | There is a signature to freeze on                                 | **There is no signature**, so "freeze on approval" has no trigger                                                                                                                                                            |
| Re-publishing is | A defect once signed                                              | **Correct.** A design PR that redraws a mock SHOULD supersede the previous result — `design-result.md` §4 says a push to an open PR re-runs the lane and supersedes, and that this is intended                               |

**So: do not "restore consistency" by adding a freeze to `designEvidenceService`.**
The asymmetry is the decision.

§5 is mirrored by a pointer in `design-result.md`, so whichever record a reader
opens first tells them.

- **Rejected: give design results an approval gate so both can freeze.** That
  would paywall-by-process the design-before-code rule the whole plan rests on,
  and invent a review step nobody asked for, purely to make two records rhyme.

### §6. A re-opened story does NOT unfreeze its receipt

`done → in_progress` is a legal transition, so this case is reachable and is
decided here rather than discovered later.

**Decision: the frozen receipt stays frozen.** The receipt records that the
story **was** accepted on a given day, on the strength of a given recording.
Re-opening the story does not make that false. A re-opened story that ships
again earns a **NEW** receipt through the ordinary path — it re-enters
`in_review`, a new recording is published, and a human signs it. The prior
receipt remains as history.

Note the mechanism this rides on, which needs no new code: the freeze in §2 keys
off the RECEIPT's status, not the story's. A re-opened story whose current
receipt is `approved` is refused a supersede exactly as before — so the new
receipt is a new row, and the old one is untouched.

- **Rejected: unfreeze on re-open.** It makes the receipt mutable through an
  indirect path — re-open, republish, and the signature is gone — which is the
  original defect reachable in two steps instead of one. It also destroys the
  more interesting record: that a story was accepted, and then re-opened anyway.

### AMENDMENT 1 (2026-09-21, MOTIR-5872) — approval pins the RECORDING; it does not freeze the STORY, and it does not evict the SPEC

> _"The approval action is linked to the card status, but it doesn't lock the card
> status."_ — Yue, 2026-09-20

**What went wrong.** §2 keyed the freeze on the RECEIPT's status and §6 said a
re-opened story stays frozen, on the assumption that a story only moves forward:
publish → approve → merge → done. MOTIR-5799 is the story that made card motion
non-monotonic: a merge that does not land sends the story back. Its receipt was
approved while its pull request sat in the merge queue; the queue ejected it;
the story came back to `implemented` to be reworked — and could now **never
record again**. The story could change and its evidence could not. §3 then
compounded it: the lane guard (a test in the MAIN suite) demanded the spec leave
the lane, so every pull request in the repository went red over a feature that
was still live.

**The category error.** An E2E spec is a TEST; it runs while its feature is live.
The video is a by-product of one run. §3 tied the test's lane membership to
whether a RECORD had been signed. The lane's real problem — specs accumulating in
an expensive lane that is not a regression gate — is a PLACEMENT question,
answered once when the spec is written. It is not something an approval should
trigger.

**The decision, in three parts that are one change:**

1. **Approval PINS the recording.** A publish over an `approved` receipt is no
   longer refused because of the receipt. It supersedes it — and the approved
   row's video and trace stay LINKED, so the orphan-GC never reclaims them. The
   row keeps `status: 'approved'` and its approver stamp as history. This is the
   same promise `design_evidence.pinned_at` makes for an approved design version
   (`design-result.md` §6c). Unapproved recordings (`pending`,
   `changes_requested`) are still unlinked and collected — the intended loss.
2. **The refusal is keyed on the STORY, exactly as the design gate's is**
   (`designEvidenceService`'s `assertStatusOpen` + `assertDesignSettled`).
   `acceptanceEvidenceService` refuses a publish with
   `ACCEPTANCE_EVIDENCE_STORY_CLOSED` (409) in two cases and no others:
   - the story is **closed** (a terminal status) — its acceptance is decided;
   - the story **still stands on the approval** — its current receipt is
     `approved`, it is at or above `implemented`, and a pull request of its is
     still open. That merge would ship with whatever receipt is current, so a
     republish in that window would carry a recording nobody approved to `done`.

   Below `implemented` the work is being redone, which is exactly when a new
   recording is right. **A person pulling the story back (to `in_progress`) is the
   deliberate re-open**, and the pulled-back move already withdraws every awaiting
   question. Its code is `ACCEPTANCE_EVIDENCE_STORY_CLOSED`
   (`AcceptanceEvidenceStoryClosedError`), and it REPLACES the approved-receipt
   refusal MOTIR-2764 introduced, which froze the story for ever.

3. **The lane guard no longer reads receipt status**
   (`tests/e2e-acceptance-lane-membership.test.ts`). It keeps the half that is true
   of the spec file — a spec that declares no story can never publish a receipt —
   and evicts nothing on approval. PROMOTE and RETIRE (§3) remain the two ways a
   spec leaves the lane; choosing one is an authoring decision about where the test
   belongs, not something a signature forces. The credential stack the old read
   needed is retired by MOTIR-5874.

**Why they are one change.** Part 1 alone leaves the guard evicting a live spec;
part 3 alone leaves a reworked story unable to re-record.

**What each superseded passage now reads as:**

| Section                                             | Was                                            | Now                                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §2 `approved` row                                   | REFUSED — nothing written                      | SUPERSEDED, bytes PINNED — unless the story is closed or still stands on the approval (above)                                                                                                                            |
| §2 "Rejected: freeze when the story reaches `done`" | rejected                                       | ADOPTED as the closed-story half of the refusal. Its objection — a story can reach `done` with no video — does not apply: a story with no receipt has nothing to protect, and one with a receipt is protected by the pin |
| §3 trigger                                          | "once a receipt is frozen" the spec must leave | A spec leaves by PROMOTE or RETIRE when its author decides where the test belongs; nothing forces it on approval                                                                                                         |
| §4 layer 1                                          | the service refuses an approved supersede      | the service PINS an approved supersede and refuses on the STORY's state                                                                                                                                                  |
| §4 layer 3                                          | the guard fails a spec whose story is accepted | the guard fails a spec that declares no story                                                                                                                                                                            |
| §6                                                  | a re-opened story's receipt stays frozen       | a re-opened story records again; the approved recording stays on record as history. §6's own objection — "re-open, republish, and the signature is gone" — is answered by the pin: the signature is never gone           |

**Unchanged:** §1 (the entity split), §5 (a design result is not a receipt), and
the rule that a red acceptance spec is DISPOSITIONED, never edited to describe
today.

### AMENDMENT 2 (2026-10-24, MOTIR-9411) — MOVE: a done story's spec keeps its triggers

**What happened.** AMENDMENT 1 stopped evicting a spec when its receipt was
approved, and nothing else forced the §3 disposition. The lane grew from 26 specs
(2026-08-13) to 158, every one of them for a done story. Measured on 2026-10-23:
the lane is the slowest CI workflow (a green PR run of 113 minutes wall clock,
348 runner-minutes on 10 legs), and about 136 minutes of its specs are pacing
holds that no regression run needs.

**Why PROMOTE was the wrong default for them.** §3 promotes into a lane that
runs on EVERY pull request. The acceptance lane does not: a PR or queue entry
runs it only when it touches the lane's own paths (MOTIR-4257), and `push: main`
runs it in full (MOTIR-2760). Promoting 150 specs into the main or cloud lane,
even with the holds stripped, moves about an hour and a half of browser tests
onto every app PR. That trades a cost paid once per merge for a larger one paid
on every pull request.

**The decision.** §3 gains a third route:

| Route    | What it means                                                                                                                                                                                                                                                 | Choose it when                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **MOVE** | Rename `acceptance-<x>.spec.ts` to `regression-<x>.spec.ts` and swap its import to `_helpers/promoted-regression`. **Keep every assertion.** It runs under `playwright.regression.config.ts`: the acceptance lane's cloud-on server, no pacing, no recording. | The flow needs the acceptance lane's server or is not worth a place on every PR, and no other spec already covers it. |

The regression lane has the acceptance lane's triggers: lane-touching PRs and queue
entries, and every push to `main`. It is one of the needs of `Acceptance complete`,
so it is gated by the same required check. PROMOTE and RETIRE stand as they
were. MOVE is the default for a done story's spec, PROMOTE is for a flow that
earns a place on every PR, and RETIRE is for a flow already covered elsewhere.
The acceptance lane goes back to holding only stories in flight.

**Still rejected:** leaving a done story's spec in the acceptance lane. That
is the state this amendment cleans up.

---

## Consequences

- **MOTIR-2764 (service refusal) is unblocked by nothing here and ships first.**
  Its typed error is the contract MOTIR-2768 branches on; that ordering is a real
  dependency and is wired as one.
- **The acceptance lane shrinks to the in-flight set.** After MOTIR-2769, lane
  membership is "stories currently in review", which is a small, self-limiting
  number rather than a monotonically growing one. The lane's per-run cost stops
  compounding with every shipped story.
- **The `paths:`-filter blindness (MOTIR-2760) gets smaller, not solved.** A lane
  holding only in-flight stories is a far smaller thing to decide a trigger
  policy for. That decision stays with MOTIR-2760.
- **Some promoted specs will go red on their first honest run.** A spec that has
  sat in a rarely-firing lane has been drifting against the product with nobody
  watching; joining the lane that runs on every PR is where it says so. That red
  is the regression coverage working, and MOTIR-2769 owns fixing it.
- **A spec author now has a lifecycle to know about**, which is why MOTIR-2772
  puts it in the three places an author actually meets it: `docs/acceptance-video.md`,
  the workflow header, and `CLAUDE.md`'s E2E section.
- **What is NOT decided here:** when the acceptance lane triggers (MOTIR-2760),
  and anything about the design-result lifecycle beyond the §5 carve-out.
