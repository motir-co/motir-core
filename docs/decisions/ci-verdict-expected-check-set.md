# The CI verdict establishes the commit's check set instead of inferring it

**Status:** accepted · **Card:** MOTIR-4199 · **Date:** 2026-09-03
**Supersedes nothing. Amends:** `docs/decisions/ci-feedback-comment-per-card.md` (MOTIR-2946 /
MOTIR-3770) and the promotion contract in `lib/services/ciPromotion.ts` (MOTIR-3006 · MOTIR-3685 ·
MOTIR-3823).

---

## The observation

On 2026-09-02, at `20:45:57.664Z`, Motir wrote this onto MOTIR-3941:

> ✅ **CI passing** — all **3** checks succeeded on the linked pull request. This work is verified.

and promoted the card `implemented → in_review`. The commit — `4eae3f0`, on
moooon-B-V/motir-ai#367 — had **five** jobs, all queued at `20:45:26Z`:

| check                                    | status at 20:47                                       |
| ---------------------------------------- | ----------------------------------------------------- |
| TypeScript build                         | `success`, completed `20:45:58Z`                      |
| Boot smoke (native-ESM interop)          | `success`, completed `20:45:56Z`                      |
| Prettier                                 | `success`, completed `20:46:09Z`                      |
| **Vitest**                               | **still running** — the repository's 3 000-test suite |
| **Indexer image / Build, assert, prove** | **still running**                                     |

Nothing was red, so nothing looked wrong. Had Vitest gone red, the card would have sat at In Review
carrying a comment saying it was verified.

## The mechanism

Three derivations, one shared premise:

- `changeRequestCiFeedback.deriveCiState` — _any `failure` → failing; else any `success` → passing;
  else null_. Its own doc says non-terminal rows "never gate the verdict".
- `summarizeChecks` — `total` is `rows.length`, `pending` is how many of those rows are `pending`.
  With no pending ROW recorded, `pending` is `0` and the comment renders the terminal form.
- `prCiState.derivePrCiState` — which BOTH promotion edges ask — returns `running` when a live row at
  the head sha is `pending`. So the promotion fires exactly when the table holds no pending row.

**All three read "no pending row" as "nothing is pending".** Nothing in the path knew how many checks
the commit HAS. GitHub delivers check runs one webhook at a time, so a recorded set that is a PREFIX
of the real set is not an edge case — it is the ordinary state of every pull request for the first
minutes of its life, and the promotion fires on the first terminal green inside that window whenever
the pending rows for the slower jobs have not landed yet.

It is the twin of MOTIR-3823 (_"In Review is a promise to a person, made here before the build has
spoken"_) arriving through a different door: not `null` read as green, but a PARTIAL set read as
complete. It takes the same shape of remedy — **a fact established, not an absence inferred.**

## The decision

**Ask the host, and write the answer into the table every derivation already reads.**

1. `lib/github/checkRuns.ts` gains `readCommitCheckRuns` — `GET /repos/{owner}/{name}/commits/{sha}/check-runs?filter=all`,
   under the `checks: read` permission the App already holds, mapped through the GitHub provider's own
   `mapGithubCiConclusion` so a row written from a REST read is indistinguishable from the row that
   delivery would have written.
2. `lib/services/checkSetReconcile.ts` writes a `github_check_run` row for every reported check the
   recorded set is missing.
3. Nothing downstream learns a new concept. A `pending` row at the head sha ALREADY makes
   `summarizeChecks` render `⏳ CI running — 3 of 5 checks complete`, ALREADY makes `derivePrCiState`
   return `running`, and `running` is ALREADY what both promotion edges withhold on. The defect was
   never in how the folds treat what they see; it was that they could not see two of the rows.

### Where it is called from, and why in two places

| edge                                               | how it reaches the reconcile                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the CI-feedback consumer (`applyCiStatusFeedback`) | through the provider-supplied `CiFeedbackContext.readReportedCheckSet` callback — the same seam `buildChecksUrl` arrives on, so the consumer stays provider-agnostic and GitLab supplies none |
| `promoteIfCiAlreadyGreen` (the ARRIVAL edge)       | directly, with an injectable reader defaulting to the real one                                                                                                                                |

The arrival edge needs its own call because it has no delivery behind it: it fires the moment a card
reaches `implemented`, which a run does right after `gh pr create` — when the recorded set is at its
most partial. Left reading only what is recorded it would promote three-of-five for exactly the reason
edge 1 no longer does, and the two edges would disagree in precisely the window edge 2 exists for
(`ciPromotion.ts`'s own header: _the latch only works if the two edges ask the same question of the
same set_).

## The cost, measured

**One round trip per delivery that would otherwise assert a verdict** — that is, only when the
recorded set CLAIMS to be complete (at least one live row at the head sha, none of them `pending`).

- In the healthy case, GitHub's `created` / `in_progress` deliveries record `pending` rows before the
  slow lanes finish, so the set never claims completeness and **no call is made at all**.
- In the fixture's case the claim is made on the first terminal delivery, the reconcile fills in the
  missing rows, and every subsequent delivery at that commit sees a pending row and pays nothing.
  `tests/github/ciExpectedCheckSet.test.ts` asserts this directly: three successes on a five-job
  commit produce **one** host call, not three.
- A motir-core pull request carrying ~34 checks therefore pays for one round trip, not thirty-four.

The call is made OUTSIDE the transaction in both paths. On the feedback path the snapshot is taken
before `githubPullRequestRepository.lockById`; on the arrival edge the pass is three phases (read the
members, ask the host, write what is missing) rather than one, so no connection is held open on
GitHub's latency.

## What it does NOT answer — the failure modes, stated

1. **It is a snapshot of the runs the host has CREATED.** ~~A workflow that has not started at all — a
   `workflow_dispatch` nobody fired, a job queued after the call — is in no snapshot and cannot be.~~
   **Corrected by AMENDMENT 3 (MOTIR-6946):** a workflow run GitHub has created but that has no job
   yet IS in a snapshot — its check SUITE exists from the moment the run does — and the read now takes
   it. The genuine limit is a workflow that has not been TRIGGERED (a `workflow_dispatch` nobody
   fired). The window narrows from _however many webhooks have been processed_ to _however many
   workflow runs the host has created_.
2. **A path-filtered workflow legitimately reports fewer checks than it defines**, and this is
   invisible to the reconcile and correctly so: the host reports the runs it created for THIS commit,
   which is exactly the set the verdict should be about. A repository whose `ci.yml` skips its app
   lanes on a docs-only diff reports the lanes it ran, and the card is judged on those.
3. **`null` is "no answer", not "no checks".** An unconfigured App, an unmintable token, an
   unreachable host, a 403, an unparseable body, or a commit carrying more than 500 check runs all
   answer `null`, and every caller then falls back to the recorded set — i.e. to the behaviour that
   shipped before this card. **A transient GitHub outage costs the sharper verdict rather than
   stalling every card behind it.** The opposite choice (withhold on `null`) was rejected: it converts
   an outage into a fleet-wide stall of every card at Implemented, with no signal saying why.
4. **The reconcile writes the host's OWN conclusion, not `pending` for everything it lacked.** Writing
   `pending` looks more conservative and is worse: a dropped webhook delivery would leave a card held
   at Implemented for ever behind a row nothing will refresh. The two transports describe the same
   checks, so a run the host reports as completed is recorded as completed — which makes a dropped
   delivery **self-healing**. The webhook's own later delivery upserts the identical value and is a
   no-op.
5. **It only ever CREATES** (`githubCheckRunRepository.createMissing`, `createMany` with
   `skipDuplicates`). The snapshot is taken outside the writing transaction, so a delivery about one of
   these checks may land in between; the unique key
   `(pull_request_id, commit_sha, check_name, check_suite_id)` is the arbiter, and a row that exists
   wins whatever the snapshot believed about it. That is what lets the arrival edge's pass run with no
   lock of its own, and it is why a `pending` written here can never overwrite a terminal conclusion.
6. **GitLab is unchanged.** Its provider supplies no `readReportedCheckSet`, so its verdicts are
   formed exactly as before. Closing that half is a separate card.

## The alternative that was not taken

The card named a second candidate: **record the EXPECTED set from the `workflow_run` / `workflow_job`
deliveries motir-core already handles** — a `workflow_job` `queued` names a job before its `check_run`
reports, so the feedback could know the commit has five jobs when three have completed. No extra call.

Rejected, for three reasons:

- It needs new persistence (an expected-set table keyed per `(repo, sha, run)`) where candidate 1
  needs none — the reconcile fills in the table that already exists.
- `handleWorkflowJob` today routes to `ciRunnerProvisioningService`, whose parser is scoped to fleet
  jobs; a general expected-set recorder is a different subscription and a different consumer.
- It depends on job events arriving before the last check completes, which the card itself calls
  "the normal order but not a guaranteed one". Candidate 1 asks the party that KNOWS, at the moment the
  answer is needed, and is exact.

## What is asserted

`tests/github/ciExpectedCheckSet.test.ts`, against real Postgres and the real promotion path:

- three successes on a five-job commit write the interim `3 of 5` comment and promote nothing; the
  two missing checks are recorded as `pending` rows;
- the same sequence completed writes the terminal comment ONCE (one comment, edited in place) and
  promotes; a fourth success plus a fifth `failure` writes `CI failed — 1 of 5` and holds the card at
  Implemented;
- **both edges separately** — `promoteDeliveredCardsOnGreen` returns `[]` and `promoteIfCiAlreadyGreen`
  returns `false` on that same set; and the arrival edge asks the host itself when nothing has
  reconciled before it;
- the control: the identical deliveries with no host callback reproduce the defect verbatim
  (`all 3 checks succeeded`, card at In Review), so the fixture cannot pass for an unrelated reason;
- the cost rules — not paid while a pending row is recorded, paid once per claim, falls back on a
  `null`, records nothing on an empty answer;
- the reconcile never overwrites a terminal row, and a dropped delivery self-heals.

MOTIR-3823's own criteria are unchanged and still green (`tests/github/ciGreenPromotion.test.ts`): a
repository that CANNOT report still counts as green, and a pull request with zero rows in a repository
that CAN report is still not promoted.

## AMENDMENT 4 — the re-read is asked of the PULL REQUEST, whatever its cards' status (MOTIR-11638)

**AMENDMENT 1 put the stale-pending re-read inside the Implemented → In Review latch, and so it ran
only for a card at `implemented`.** `reconcileClaimedCompleteDeliveries`' first step is _is this card
at `implemented`?_, and the reconcile tick reached the re-read only through that latch. A card already
In Review was never re-read — and In Review is where every fix after a review send-back runs, so all
of that fix's CI ran outside the window the re-read covered.

**Observed** (2026-11-17, motir-core#4306 / MOTIR-11585): the review agent sent the card back at 03:52
on head `4f119995`; the fix `2cb7524b` was pushed at ~03:57 with the card still In Review. On GitHub
`Coverage (run overlay parity)` completed `success` at 04:00:59 and `CI complete` at 04:28:56; in
Motir that check's row was still `pending`, created and last updated at 03:58:31. The card's `ciState`
read `running`, the CI comment read "75 of 76 checks complete", and `fixReasonService` — reading CI
running at a head other than the one the send-back was raised on — held `changes_requested` as
Fixing. The review agent's pass at 11:20 could not clear it, and nothing would have until another
delivery arrived.

**The decision.** The re-read is a fact about the pull request's recorded set, so it is asked per pull
request: the reconcile tick calls `lostCheckCompletionService.settleLostCheckCompletions` for every
open delivering pull request it reaches, BEFORE the latch, with the same two predicates and the same
host read and `pending`-guarded write (`reReadCheckSetFromHost`, shared with the latch). When the read
changed the set, what the lost delivery would have done next is done, in the CI-feedback consumer's
order: every delivered card's `ciState`, fix reason and resume state recomputed
(`recomputeCardCiAnswers`, now the consumer's helper too); the CI comment re-rendered at the commit
whose set changed; then the verdict latches — a red set withdraws the merge question, a green one
promotes from `implemented` and re-raises the question for a card already in review. **The promotion
stays the only status-gated part.**

**What it costs.** A fresh pending row is still believed without a call. A set claiming completeness
is asked about once per head rather than every tick: the read that finds the host decided records
`ciDecidedSha` (MOTIR-10797), and the sweep does not ask again about a complete set at a head the host
has already decided. A stale pending row at such a head — a re-run whose completion was lost — is
still asked about. The tick's summary counts the settles as `checkSetsSettled`; like `promoted`, one
is a lost delivery repaired and a steady trickle is an ingestion defect.

## AMENDMENT 3 — a workflow run with no job yet is READ, and failure mode 1 was wrong about it (MOTIR-6946)

**Failure mode 1 said a workflow that has not started "is in no snapshot and cannot be". For a
workflow run GitHub has already CREATED, that was false**, and the error was not academic.

**Observed** — moooon-B-V/motir-core#3261 @ `688ce704`, 2026-09-29. Three workflow runs were created
at `18:39:32` (Acceptance tests, CodeQL, CI). CI's run sat for **86 s with no jobs**, held by `ci.yml`'s
workflow-level `concurrency: ${{ github.workflow }}-${{ github.ref }}` group while the previous head's
run was cancelled. The acceptance lane settled green at `18:40:05`; the recorded set claimed to be
whole; the reconcile asked `/commits/{sha}/check-runs`, which held no CI row, and confirmed the prefix.
The approve-to-merge gate was raised at `18:40:08`. CI's first job appeared at `18:40:58`. The
concurrency group opens this window on most pushes to an open motir-core pull request.

**GitHub knew.** `GET /commits/{sha}/check-suites` answered, for that commit: three third-party suites
(`vercel`, `sentry`, `claude`) `queued` with **zero** runs — as they are on every commit, for ever —
and three `github-actions` suites, one per workflow run, CI's `in_progress`. motir-core defines ~20
workflows; only the three that triggered have a suite, so an Actions suite IS a workflow run that
will report.

**The decision.** `readReportedCheckSet` now also reads the commit's check suites and reports every
**GitHub Actions** suite as its **roll-up row** — `checkName` = the App slug `github-actions`, the
suite id, `suiteAggregate: true`, `pending` until `completed`. That is byte-for-byte the row a
`check_suite` delivery records (`parseCiStatusEvent`), so nothing downstream learns a new concept: a
pending roll-up folds the set to `running` and both promotion edges withhold, and the suite's own
`completed` delivery upserts it terminal. Three rules on how it is written:

1. **Only while pending is a roll-up CREATED.** A finished suite is already recorded by its own
   delivery; creating a terminal one here would make the read a second writer of a verdict the
   webhook owns (and would, for a run cancelled before it created a job, write a `failure` nothing
   supersedes). A finished suite in the answer still SETTLES a pending roll-up the read created —
   AMENDMENT 1's lost-completion arm, unchanged — which is the whole reason it is reported.
2. **Only the `github-actions` App.** A third-party App's suite is not a workflow run and never
   reports; counting it would hold every card on every commit.
3. **The suites read failing is not the set failing.** When `/check-suites` answers nothing, the check
   runs alone are returned — the set that shipped before this amendment — rather than `null`, which
   would discard an answer the first read did get. Failure mode 3 holds for the check-run read as
   before.

**Why `/check-suites` and not `/actions/runs?head_sha=`.** The workflow-runs endpoint names the
workflow and was the obvious read. It needs `actions: read`, which the user-facing App
(`motir-integration`) does not hold (`unlinked-pull-request-check.md`'s permission table) — so it
answers 403 on exactly the repositories this was observed on, the tolerant `null` arm absorbs the 403,
and the fix would have shipped inert with every stubbed test green. `/check-suites` needs `checks: read`,
which every installation already grants.

**What it costs.** One more round trip, paid on the same edges as the first: a set claiming to be
whole (MOTIR-4199) or claiming too long to be running (MOTIR-5838). Once a pending roll-up is
recorded the set no longer claims to be whole, so the ordinary pull request pays for it once.

**What is left.** A workflow that has not been TRIGGERED is in no snapshot, and cannot be. And the
raise is still not the only defence: a set that leaves green without going red at the asked-about
head now withdraws the question too (`approval-gates.md` §8's SEVENTH AMENDMENT, cause
`ci_rerunning`), so a window this read still misses is corrected when its first check arrives.

## AMENDMENT 2 — the residual window is CORRECTED downstream, not closed here (MOTIR-6271)

**Failure mode 1 above is not a caveat; it is load-bearing, and nothing in this
decision was ever going to remove it.** A host read establishes the runs GitHub
has CREATED. A workflow whose later jobs do not exist yet is in no snapshot and
cannot be — and on `motir-core` that is not an exotic shape: the `Vitest (n/12)`
legs are created only once earlier CI jobs finish, so **every** pull request here
has a window in which the recorded set is complete, terminal and green while the
lanes that will fail have not been created.

Failure mode 3 widens the same window on purpose. An unreachable host answers
`null`, and every caller then falls back to the recorded set — _"a transient
GitHub outage costs the sharper verdict rather than stalling every card behind
it"_. That is still the right trade, and it means a verdict formed over a partial
set is an ACCEPTED outcome of this design rather than a bug in it.

**Observed, at the cost the window was always going to have** — `#3112` @
`88508fb2`, 2026-09-24. The approve-to-merge gate was raised at `22:45:19.033`
and routed to a person. `Vitest (3/12)` and `(6/12)` were CREATED at
`22:45:27/28` — **eight seconds later** — and failed at `22:58`; `CI complete`
failed at `23:02:17`. The gate was still `awaiting` over that commit hours
afterwards, because nothing retired it.

**The decision: the correction belongs to the WITHDRAWAL, not to a wider read.**
`approval-gates.md` §8's SIXTH AMENDMENT adds the `ci_failed` cause and the path
that writes it, so a verdict contradicted by the build retires the question it
raised. This ADR's callers are unchanged.

**The alternative, and why it is NOT taken.** A COMPLETION SENTINEL — requiring a
terminal aggregate check (`motir-core` ships one, `CI complete`) before any
verdict — would narrow the window further. It is rejected for the same three
reasons the expected-set candidate was rejected above, plus a fourth: it makes
the verdict depend on a workflow CONVENTION, so a repository without that job
would never be judged green at all, which is the fleet-wide stall failure mode 3
exists to refuse. A window that is corrected a few minutes later is cheaper than
one that never opens for some repositories.

**What this amendment does NOT say.** It does not excuse a caller from the
reconcile. The two callers named in the table above still pay for it, and a THIRD
raise path — the rung reconcile
`workItemsService.applyStatusTransition` runs on every transition to a rung at or
above `implemented` (MOTIR-5652 / MOTIR-5663) — folds the recorded rows with no
reconcile of its own. It is in-transaction, so it cannot make a host read where it
stands; whether it should be deferred past the commit or left to the withdrawal to
correct is **open**, and MOTIR-6271's own investigation could not settle which
path raised `#3112`'s gate. The withdrawal covers every one of them, which is why
it is the fix that shipped first.

## AMENDMENT 1 — a set claiming to be STILL RUNNING is distrusted too, once it has claimed it too long (MOTIR-5838)

**The decision above is asymmetric, and the missing half cost a green pull request its merge.** It
taught the reconcile to distrust a recorded set asserting _I am whole_, and left the set asserting
_I am incomplete_ trusted absolutely. But `running` is exactly what a LOST completion produces:
`derivePrCiState` folds any live `pending` row at the head to `running`, so a webhook that never
arrived is indistinguishable — for ever — from a lane that is genuinely still going.

**Observed** (2026-09-19, PR #2994 / MOTIR-5782): GitHub reported 22 `completed/success` and 8
`completed/skipped` at head `7bf7511e3`, **0 pending**, combined status `success`. Motir's delivery
row read `ci: "running"`. The card sat at `implemented` from 20:20:41; the 21:00 and 21:30 reconcile
ticks changed nothing, and re-firing the latch by hand did not repair it. There is no agent path to
an approval gate and no UI control that re-asks the host, so the only recoveries were pushing another
commit or an operator writing to the database.

**Every path declined, by design.** The latch's reconcile excluded the case in as many words —
_"A member with a live pending row is already `running` and already withholds, so there is no claim to
check."_ The 30-minute tick replays lost CLOSES and re-raises missing GATES, and while the card is not
promotable **no gate is owed**, so it raised nothing: correctly, and permanently.

**The decision.**

1. **The claim to distrust is AGE, not shape.** `stalePendingSha` names the head sha when a live
   `pending` row there has been `pending` longer than `STALE_PENDING_MINUTES` (**10**, deliberately
   the same number as `PULL_REQUEST_RECONCILE_QUIET_MINUTES` and deliberately its own constant — the
   two measure different clocks and the agreement is a judgement about how long a lane plausibly
   runs, not a fact either module may read off the other). `shaToReReadFromHost` is the two arms
   asked as one question.
2. **The no-cost property of the decision above is KEPT.** A fresh pending row is the ordinary state
   of every pull request for its first minutes and is believed without a call. A pull request
   qualifies under neither arm for its whole normal life, and pays exactly what it paid before.
3. **`reconcileRecordedCheckSet` also SETTLES a row it holds as `pending` that the host reports
   complete** — the case creating-only structurally cannot reach, because such a row is not missing.
   **This narrows point 5 above rather than reversing it**, and the guard is what makes it safe:
   `githubCheckRunRepository.settlePending` puts `conclusion: 'pending'` in the WHERE, so the arbiter
   is still the row's own current value read in its own statement rather than the snapshot's belief
   about it. It can only move a row `pending → terminal`; `pending` is the only non-terminal
   conclusion, so no information can be lost in that direction, and **a terminal row is still never
   overwritten by this path.**
4. **The 30-minute tick reaches the same code**, so a card stranded this way repairs itself within
   the hour — the guarantee that sweep already advertises for a lost merge.
   `pullRequestReconcileService`'s still-open arm calls `promoteIfCiAlreadyGreen` for each delivered
   card, which is the SAME edge-2 latch with the same re-read, the same `isPromotable` and the same
   gate raise. **It adds an OCCASION, not a promotion path**, so there is no second answer to drift
   from the first; the summary counts it as `promoted`, to be read the way `gatesRaised` asks to be
   read — a steady trickle is an ingestion defect, and the ingestion is the bug to fix.

   **Its cost is bounded by the sweep's own bounds**, which is why it is affordable on a schedule:
   the pass already examines at most `PULL_REQUEST_RECONCILE_BATCH_SIZE` (50) candidates, only rows
   quiet for the threshold, and only rows still delivering a live card — and within that, a card pays
   a check-runs round trip only when its set makes one of the two claims. The ordinary open pull
   request with a pending lane makes neither and is not asked about at all.

**What is asserted** — `tests/github/ciStalePendingReread.test.ts` (the predicate, both sides of the
threshold and its exact boundary, the stranded card promoted with its gate raised, the fresh row not
re-read at all, a host still reporting `pending` settling nothing, a lost FAILURE recorded as a
failure, and a terminal row never clobbered by a staler snapshot) and
`tests/github/pullRequestReconcile.test.ts` (the tick driving the whole repair end to end against a
stubbed host, and leaving a genuinely-running lane where it is).
