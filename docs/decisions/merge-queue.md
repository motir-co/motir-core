# Two green pull requests may not merge into a red `main` — the merge queue, and what it costs

**Status:** accepted · **Date:** 2026-09-02 · **Card:** Bug MOTIR-4050 (Epic MOTIR-3875) ·
**Evidence pinned at:** `motir-core` `origin/main` @ `a42f2e22`, ruleset `17227448` as read
2026-09-02, CI job durations from run `33623306489`, merge rate from the 200 most recently
merged pull requests · **Supersedes:** the merge-queue rejection in
[`ci-minutes-allowance.md`](./ci-minutes-allowance.md) §J.5 — see §7

> The card asked for one thing above all: **that the setting be DECIDED and the reasoning
> recorded, including — if the answer were "not worth the CI cost" — that answer with its
> numbers.** §3 is the decision, §4 is the cost, §5 is the human half, and §6 is the
> measurement that is still owed.

---

## §1 — The class, and the instance that produced this card

On 2026-08-31 `main` was un-typecheckable for ~40 minutes, red-lighting the `TypeScript`
check on every open pull request. Neither pull request involved was broken:

|             |                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `11:40:02Z` | **#2480** (MOTIR-1789) goes green. `ProjectRoadmapCanvas` does not require `searchLabel` yet.      |
| `12:09:16Z` | **#2486** (MOTIR-4016) merges, making `searchLabel` required whenever `searchable` is true.        |
| `12:34:47Z` | **#2480** merges, on a **55-minute-old** green check taken against a `main` that no longer exists. |

They touch different files, so git merges them cleanly and reports no conflict. The type
error exists only in the composed tree. Every signal a reviewer looks at was honestly green.
MOTIR-4047 / PR #2490 repaired it; **this decision is the control, not the patch.**

The class is not rare here. It recurs whenever two pull requests touch opposite ends of one
contract, which is routine on a repository with a shared component library and several
concurrent agents. The global lesson _"Green on two branches is not green on their sum"_
reached the same conclusion independently — _"the finding is a merge-order class and the
remedy is a repository control, not a patch"_ — and this was its second recorded occurrence.

**Nothing in the setup as it stood noticed.** A pull request's checks are computed against
the `main` of the moment they ran, `protect-main`'s `strict_required_status_checks_policy`
is `false`, and nothing re-computes anything at merge time. The push-to-`main` run found
the breakage 25 minutes later, which is a detector, not a gate.

## §2 — The three options the card named, measured

Measured 2026-09-02. **`motir-core` is a public repository, so GitHub-hosted minutes are
free** — every cost below is throughput and wall clock, never dollars. That is the right
denominator anyway: the binding resource here is how fast a change can land, and how many
agents are waiting behind it.

**The traffic.** Merges to `main` per day over the preceding week: 25 · 50 · 54 · 21 · 23 ·
11 · 10. Median ~25, peaks above 50. Open non-draft pull requests at the time of
measurement: **4**.

**The gate.** From run `33623306489` — 12 Vitest legs at ~8 min each, 10 Playwright legs at
~5.5, four at-scale legs at 3.3–9.6, `Next.js build` 3.5, `Lint + Prettier` 4.1,
`TypeScript` 2.7, `Structural guards` 2.2, `Vitest coverage` 1.4, the package lanes ~1.2
each. **~183 runner-minutes, ~11–15 minutes of wall clock**, plus `Deploy to Fly` at 6.7.

### §2.1 — Option 1, "require branches to be up to date": **REJECTED — it does not converge**

`strict_required_status_checks_policy: true` invalidates every open pull request's check on
every merge. The cost is O(merges × open pull requests): at the measured 25 × 4 that is
**~100 extra full gates a day**, and on an 08-27-shaped day ~200.

**But the cost is not the reason.** At 25 merges spread across eight hours a merge lands
every ~19 minutes, against a gate of 11–15; on a 50-merge day, every ~10 minutes. A pull
request that starts re-running is invalidated again before it finishes. Pull requests would
merge by winning a race rather than by being green — and the more agents run concurrently,
the worse it gets, which is precisely backwards for this repository.

### §2.2 — Option 2, "require it only for the cheap, decisive checks": **REJECTED — it is not a saving**

The card asked for this to be checked rather than assumed. It was, and it fails twice over.

1. **There is nothing to scope.** `protect-main` requires exactly ONE context — `CI
complete`, the aggregate job MOTIR-2008 introduced so that a shard rebalance could not
   wedge a pull request. `strict_required_status_checks_policy` is one boolean over the
   whole rule, not a per-check flag.
2. **Even after splitting the aggregate, it saves nothing.** Strictness governs when the
   merge button unlocks — not what runs when a branch is updated. `ci.yml` triggers `on:
pull_request`, so any push to the branch re-runs the whole workflow, and the `changes`
   job computes its filter over `base...head`, which an "Update branch" merge commit does
   not change. Option 2 buys the full cost of option 1 for a fraction of the guarantee.

### §2.3 — Option 3, a merge queue: **TAKEN**

A queue builds a temporary `gh-readonly-queue/main/pr-<n>-<sha>` branch holding `main` ⊕ the
entries ahead ⊕ this pull request, runs the required checks against **that**, and
fast-forwards the tested commit onto `main`. Replayed against §1: whichever of #2480 / #2486
queued second would have seen the other in its speculative tree and been ejected before the
merge, with `main` never going red.

Its cost is **O(merges)** — one run per entry, or per batch — and it does not touch open
pull requests at all. That is the property that distinguishes it from §2.1, and it is the
whole reason it survives this repository's merge rate.

## §3 — The decision

**Enable the merge queue on `main`, run the FULL gate inside it, and reduce the
push-to-`main` lane to a tripwire plus the release.**

| Lane               | What runs                                                                                                 | Why                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Pull request**   | the full gate, minus `e2e-at-scale`                                                                       | unchanged. A failure must be visible before queueing, or ejection becomes the normal feedback path |
| **`merge_group`**  | the full gate, **including `e2e-at-scale`**                                                               | the composed tree is verified before it becomes `main`, which is the control this card exists for  |
| **push to `main`** | `lint`, `typecheck`, `structural-guards`, `design-system`, `design-guards`, `cli`, `build`, then `deploy` | ~4 minutes of wall clock. It is what a BYPASSED merge meets                                        |

Three things follow, and each is asserted in `tests/ci-merge-queue.test.ts`:

- **`ci.yml` gains `on: merge_group`.** Without it `CI complete` never reports against a
  queue entry, the entry times out on `check_response_timeout_minutes`, and the pull request
  is ejected with **no failing check to explain it**. Nothing goes red; merges simply stop.
- **`e2e-at-scale` moves from `push` to `merge_group`.** MOTIR-3148 put those four legs on
  the push so they would bill once per merge instead of once per pull request. That property
  is untouched — they still run once per merge, still never on an unlabelled pull request.
  They now run one step earlier, where they gate the merge instead of reporting after it.
- **`deploy`'s `needs` shrinks to `[lint, typecheck, build]`.** ⚠️ Not a relaxation — a
  necessity. A skipped `needs` entry makes its dependents skip, so leaving `test` / `e2e` /
  `coverage` / `e2e-at-scale` listed while they skip on a push would not have gated the
  release conservatively; it would have **stopped releases entirely**, and
  `deploy-freshness.yml` would have been the thing that eventually said so, 90 minutes
  later. `build` stays for the schema-drift and NFT assertions it carries, not for its
  artifact: a release whose `release_command` is `prisma migrate deploy` must not run
  against a datamodel its migrations disagree with.

**`strict_required_status_checks_policy` stays `false`**, and that is now a positive choice
rather than an omission: §2.1 is what turning it on costs, and the queue supplies the
guarantee it was the wrong way to buy.

### §3 AMENDMENT — 2026-09-13 (MOTIR-5322): the _Pull request_ row

The table above is left as it was decided. **Its _Pull request_ row no longer describes the
Vitest lane**, and [`ci-affected-tests.md`](./ci-affected-tests.md) is the decision that
changes it:

| Lane              | Vitest, as amended                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pull request**  | the files the diff reaches plus the tests that read the tree — or the full suite when a force-full path changed; no coverage gate on a subset run |
| **`merge_group`** | unchanged: the full suite, the coverage gate and E2E                                                                                              |

The row's warrant was _"A failure must be visible before queueing, or ejection becomes the
normal feedback path."_ It is now accepted that a break the subset misses is found by
ejection, for the measured reasons in `ci-affected-tests.md` §5: over the last 30 merged
pull requests the typical one selects **20.9%** of the suite's files (**18.8%** of its
cost), only **6 of 30** had to run all of it, and Vitest was **3 of 23** of the failed
queue builds §6.1 counted. Everything else in this row — the rest of the gate, and
`e2e-at-scale` staying off an unlabelled pull request — is unchanged.

> **WITHDRAWN — 2026-09-21 (MOTIR-5948).** This amendment is withdrawn by
> [`ci-affected-tests.md` Amendment 1](./ci-affected-tests.md), which re-measured the
> selection at a median of **66.5%** of the suite over 118 pull requests, past that record's
> own 50% no-go line, and reverted the pull-request Vitest lane to the full suite with the
> coverage gate. **The original _Pull request_ row in §3 stands again**, warrant included: a
> failure must be visible before queueing, or ejection becomes the normal feedback path. The
> amendment's text is kept above as the record of what was decided and why.

## §4 — What it costs, stated before it is discovered

**Per merged change, in runner-minutes** (sandbox/runner-image excluded from both sides —
they are gated on `images` and unchanged by this):

|                                 | pull request | queue       | push       | total          |
| ------------------------------- | ------------ | ----------- | ---------- | -------------- |
| **Before**                      | 163          | —           | 190        | **353**        |
| **After, unbatched**            | 163          | 184         | 23         | **370** (+5%)  |
| **After, batched 3 to a group** | 163          | 61 ⁄ change | 8 ⁄ change | **232** (−34%) |

So: **cost-neutral unbatched, materially cheaper batched**, because the second full gate is
one this repository was already paying for on every merge — it moves from after the merge to
before it rather than being added. Any framing that counts the queue's run as new cost is
measuring against a baseline where `main` runs nothing, which was never the case here.

**⚠️ It is NOT a latency improvement, and §J.5 was right about that.** Click-to-deployed
becomes queue-gate (11–15) + tripwire (4) + release (6.7) ≈ **22–26 minutes**, against the
14.5 + 6.75 ≈ 21 of the fastest measured run and the ~34 median. Roughly a wash. Anyone
re-opening this for speed is re-opening the wrong card.

**⚠️ The real variable cost is EJECTION CHURN**, and it is the number §6 asks for. With
`max_entries_to_build` above 1, entries speculate on those ahead of them; one red entry
invalidates every entry behind it and they rebuild. On a day with several failing entries
this can exceed the table above, and no measurement here bounds it.

**What is bought for that**, beyond the class in §1: the push-to-`main` lane drops from ~21
minutes to ~11 before `deploy` is reached. MOTIR-3106's starvation needed ~35 minutes of
clear air; the window in which a merge burst can starve a release shrinks by roughly half
again. The workflow-level `cancel-in-progress` expression is unchanged — a shorter run is a
smaller window, not no window.

## §5 — The human half: the settings to apply

**⚠️ No agent can make this change**, which is why MOTIR-4050 is `executor: human`. The
`ci.yml` half is inert without it, and the two are one change.

On `moooon-B-V/motir-core` → Settings → Rules → **`protect-main`** (ruleset `17227448`), add
a **merge queue** rule. Intended parameters, recorded here so a later reader can tell a
decision from a default:

| Setting                     | Value             | Why                                                                              |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| Merge method                | **squash**        | what the repository already merges with                                          |
| Maximum PRs to build        | **3**             | speculation depth. Higher merges faster and wastes more on an ejection           |
| Minimum PRs to merge / wait | **3** / **5 min** | the batching window — this is what turns a 25-merge morning into far fewer gates |
| Maximum PRs to merge        | **5**             | caps a batch                                                                     |
| Grouping                    | **all green**     | a batch merges only if every entry passes                                        |
| Check response timeout      | **60 min**        | must exceed the gate plus queue wait, or healthy entries are ejected             |

⚠️ **The minimum was applied as 1, not 3.** MOTIR-4407 §2 raised it and did not update this
table, so for a while a reader could not tell the decision from the drift. §7.6 measures what the
3 actually buys — which is less than it looks.

Leave **"Require branches to be up to date before merging" OFF** — §2.1.

**Two things this deliberately does NOT do.** The ruleset's bypass actor stays: a queue that
cannot be bypassed is an outage waiting for its first incident, and the push lane's tripwire
is what covers the bypass. And nothing here restricts who may merge.

## §6 — What is still owed

The card asks for **the measured effect on merge throughput, quoted after a day**. This ADR
cannot contain it — the setting is applied by hand after this merges — so the shape of the
measurement is fixed here instead, against §4's estimates:

1. **Merges per day** before and after, from the same source §2 used.
2. **Ejections**: how many entries left the queue without merging, and how many rebuilds
   they caused. This is the one number §4 could not bound.
3. **Click-to-deployed**, median and worst, against the 21 / 34 baseline.
4. **Whether `main` went red at all.** The primary claim. One red `main` from a composed
   tree after this lands means the queue is not doing what §2.3 says it does.

If (2) turns out to dominate, the lever is `max_entries_to_build` — lower it before
concluding the queue is too expensive.

## §7 — Relationship to `ci-minutes-allowance.md` §J.5

§J.5 (2026-08-30, MOTIR-3760) re-opened a merge queue and rejected it, correctly, **as a
latency fix**: _"it does not reduce merge→deployed time; it increases it."_ §4 agrees and
measures the same wash. That section then closed by naming where the answer would be
different — _"A merge queue is a **correctness** improvement here, and should be re-opened as
one — under the both-green-main-red heading, sized against the second run per change"_ —
which is this card, this heading, and §4's sizing.

One thing §J.5 got wrong, and it is the reason its verdict inverts here rather than repeats:
_"every change pays for a second full run rather than replacing one."_ Measured against what
`main` was actually running on every merge, the second full run **was already being paid**.
The queue relocates it. §J.5's two grounds for keeping the full matrix on the push —
`e2e-at-scale` having no pull-request run, and the push being the only verification of the
sum — are retired by §3's first two bullets respectively.

`ci-minutes-allowance.md` §J is otherwise untouched: nothing here routes a job anywhere,
sets `MOTIR_RUNNER`, or changes what `motir-core` runs on.

## §6.1 — THE MEASUREMENT §6 ASKED FOR, taken 2026-09-03 (~28 h after the rule was applied)

The `merge_queue` rule went onto ruleset `17227448` at ~`2026-09-02T14:40Z` with §5's
parameters exactly. Window: that moment to `2026-09-03T15:16Z`. **78 queue builds over 51
distinct pull requests, 38 push-to-`main` runs, 39 merges on 2026-09-03.**

### 1. Did `main` go red? **NO — not once.** This is the primary claim and it holds.

| push-to-`main` runs         | success | cancelled | **failure** |
| --------------------------- | ------- | --------- | ----------- |
| **Before** the queue (n=35) | 18      | 9         | **8**       |
| **After** the queue (n=38)  | 37      | 1         | **0**       |

The one remaining `cancelled` is a concurrency eviction, not a red trunk. **The `cancelled`
column is a second result nobody asked for:** 9-in-35 before, 1-in-38 after. MOTIR-3106's
starvation window is a function of the push lane's length, and §4 predicted it would shrink
by roughly half; it shrank further than that.

### 2. Was the CLASS actually caught? **Yes, repeatedly — and this is the finding.**

23 of the 78 queue builds failed. What failed in them is the point:

| failing job, across the 23 | count |
| -------------------------- | ----- |
| `TypeScript`               | 17    |
| `Structural guards`        | 15    |
| `Playwright E2E` (a leg)   | 5     |
| `Vitest` (a shard)         | 3     |

**`TypeScript` and `Structural guards` dominate — the cheap, deterministic, composed-tree
checks**, which is exactly the signature of MOTIR-4050's §1 and nothing like the signature of
a flake. Verified on four of the ejected pull requests: **#2551, #2562, #2566 and #2546 each
had a fully green PR lane** (12, 37, 14 and 35 checks passing, **zero failing**) at the moment
the queue refused them. Two branches, each honestly green, that do not compile together —
caught BEFORE the merge instead of forty minutes after it.

So the queue is not insurance against a hypothetical. On its first full day it refused
composed trees roughly **once in every 3.4 builds**.

### 3. Throughput: **not harmed.** 39 merges on 2026-09-03 — above the 25/day median §2 measured, and the highest since 08-28's 54.

### 4. ⛔ EJECTION CHURN AND LATENCY — §4's ESTIMATE WAS WRONG, AND WRONG IN THE OPTIMISTIC DIRECTION

**Churn.** 78 builds for 51 pull requests = **1.53 builds per merged change**, against the
1.00 §4's table assumed. 15 pull requests were built more than once. The worst is **#2546,
which burned 7 queue builds and is still open** — its PR lane is green and it fails
`TypeScript` + `Structural guards` against composed `main` every time, so each attempt is a
full gate spent re-learning the same true fact.

**Latency, measured as CLICK-to-deployed — the clock §4 predicted at 22–26 minutes:**

|                                     | §J.5 baseline (n=9)                 | measured now (n=12)                      |
| ----------------------------------- | ----------------------------------- | ---------------------------------------- |
| merge → deployed (push lane alone)  | median ~34 · best 21.2 · worst 45.2 | **median 18.5 · best 11.4 · worst 32.7** |
| **click → deployed** (queue + push) | ~34 (click = merge, before)         | **median 40.2 · best 30.7 · worst 55.6** |

The push lane did what §3 said it would — **merge→deployed roughly halved.** But
click→deployed is **~6 minutes WORSE at the median than the baseline**, not the wash §4
predicted, and the error is entirely in the queue leg: §4 sized it at the gate's 11–15
minutes and it measures **14.7–31.4**, because an entry also WAITS behind the entries ahead
of it. §4 costed a queue build; it did not cost a queue.

**This does not reverse the decision** — §2.3 took the queue for correctness and §7 records
that it is not a latency fix — but it does correct §4's number, which read as "roughly a
wash" and is not.

### 5. The lever, and why it is NOT pulled yet

Queue WAIT is the latency driver, and `max_entries_to_build: 3` is what bounds it — raising
it to 5 would cut the wait. **Do not, while roughly 30% of builds fail.** Higher speculation
multiplies the cost of an ejection: every entry built on top of a failing one is rebuilt when
it goes. With a ~1-in-3.4 failure rate, more concurrency buys latency with wasted gates, and
the measurement above says the gates are not free of consequence.

**The cheaper lever is upstream: stop entries failing.** #2546's seven builds are one pull
request that needs a rebase, not a queue that needs tuning. Re-measure after a day on which
the failure rate is below ~10%; if the wait is still the binding complaint then, raise
`max_entries_to_build` and record the trade here.

### 6. What `min_entries_to_merge: 3` actually bought — re-measured 2026-09-04 (MOTIR-4424)

§7.5 left the lever un-pulled and named the condition for revisiting it. MOTIR-4407 then raised
`min_entries_to_merge` from 1 to 3, so that "one full ~47-job CI run" would stop buying one
merge. **It does not, and the reason is not in either card.**

A nine-deep queue drained on 2026-09-04 as **2, then 1, then 1, then 1** — never the floor:

| PRs          | merged at   | group |
| ------------ | ----------- | ----- |
| #2605, #2597 | `09:42:47Z` | 2     |
| #2598        | `09:46:50Z` | 1     |
| #2599        | `09:58:01Z` | 1     |
| #2600        | `~10:08Z`   | 1     |

`min_entries_to_merge_wait_minutes: 5` is the escape hatch, and it is **always already spent**:
these entries were enqueued at 08:59–09:03 and merged 40–65 minutes later. The floor binds only
inside the first five minutes, and nothing in this repository's gate finishes inside five
minutes. **The floor is therefore inert at this gate length** — it is not wrong, it simply
cannot fire, and a reader comparing the ruleset to the merges will otherwise conclude the
setting is broken.

**⚠️ A `max_entries_to_build` SLOT IS RELEASED WHEN THE GROUP'S WHOLE WORKFLOW RUN REACHES A
TERMINAL STATE — NOT WHEN ITS ENTRY MERGES.** This is the mechanism, and it is the thing neither
§4 nor §7.5 costed. Five for five on the day, each new group created 7–20 s after a _previous
group's CI run_ completed:

| new group built    | preceded by (CI run end)                                      |
| ------------------ | ------------------------------------------------------------- |
| `pr-2598` 09:22:58 | `pr-2582` 09:22:51 — **#2582 had already MERGED at 08:58:01** |
| `pr-2599` 09:34:21 | `pr-2597` 09:34:08 (not yet merged)                           |
| `pr-2600` 09:42:50 | `pr-2605` 09:42:30                                            |
| `pr-2601` 09:46:54 | `pr-2598` 09:46:34                                            |
| `pr-2602` 09:58:04 | `pr-2599` 09:57:47                                            |

The first row carries it: #2582 was on `main`, its entry gone from the queue, and its still-running
workflow held one of only three slots for a further 25 minutes. So slots free at staggered times,
groups ripen at staggered times, and two groups are never green at once — which is why the merge
takes whatever single group is ready. **The batching this ADR was taken for is bounded by the
SLOT CYCLE, not by the group floor.**

Two consequences worth stating plainly:

- **`max_entries_to_merge: 5` is unreachable as configured.** The queue builds _prefixes_ — one
  new entry per slot, e.g. `[2601]`, `[2601,2602]`, `[2601,2602,2603]` — so the deepest prefix
  that can exist is `max_entries_to_build`. A merge cannot carry more than 3 while that is 3.
- **A slow-but-GREEN job costs the queue as much as a red one.** `ci-complete` needs
  `e2e-at-scale`, so the run — and the slot — is held by the lane's tail. On run `33856167486`
  one flaky spec that PASSED ON RETRY turned `billing-cloud` from 7.5 minutes into 30.7 and held
  a slot for the difference (MOTIR-4423). §7.5 costed ejections; this is the same bill from a
  green run, and nothing in the queue's own signals shows it.

**The failure rate, which is what §7.5 gates the lever on:**

| window                         | merge-group CI runs | failed       |
| ------------------------------ | ------------------- | ------------ |
| since 2026-09-03T10:00Z (24 h) | 121                 | 51 — **42%** |
| since 2026-09-04T00:00Z        | 42                  | 6 — **14%**  |
| since 2026-09-04T05:00Z        | 16                  | 0 — **0%**   |

**So the lever stays un-pulled, and the reason has changed.** §7.5 asked for _a day_ below ~10%;
the last 16 runs are clean and the trend is good, but today-so-far is 14% and the 24-hour figure
is 42% — worse than the ~30% §7.5 measured. Raising `max_entries_to_build` to 5 during that would
buy latency with exactly the ejection churn §4 could not bound. **Re-measure on the first day
whose merge-group failure rate closes below 10%**, and pull it then — with the note that it is
also what makes `max_entries_to_merge: 5` reachable for the first time.

## §8 — References

- `.github/workflows/ci.yml` — the `merge_group` trigger, the lane split, `deploy`'s `needs`
- `tests/ci-merge-queue.test.ts` — the three silent failure modes, asserted
- `tests/ci-fly-deploy.test.ts` · `tests/ci-changed-paths-gate.test.ts` — the two guards this
  change inverted, and why
- [`ci-minutes-allowance.md`](./ci-minutes-allowance.md) §J.4–§J.6 — the prior weighing
- [`application-hosting.md`](./application-hosting.md) §6 (Q5) — "the suite that exists is
  the gate, and the deploy follows it", which still holds; the suite moved, the order did not
- `motir-core` PRs #2480, #2486, #2490 — the instance, end to end
- MOTIR-4047 (the patch) · MOTIR-2003, MOTIR-3106, MOTIR-3148, MOTIR-3760 (the lineage)

## §9 — AMENDMENT 2026-10-20: the queue runs the acceptance lane only for an entry that touches it

**What changed.** `acceptance-tests.yml`'s `membership` gate now reads a `merge_group` entry's own
`base_sha...head_sha` diff, as a pull request's file list is read, and runs the lane only when that
diff touches a lane path (a spec, the workflow, its config, or the two helpers). Otherwise `run=false`:
no build, no legs, and `Acceptance complete` still reports green. A payload without shas, or a diff
that cannot be taken, fails open and runs the lane. The whole lane runs against `main` in the nightly
(see the 2026-11-02 note below), not in the queue.

**Why.** Measured over the 30 most recent queue entries (2026-10-19/20): the `CI` run took 27–38 min
(median ~34), the `Acceptance tests` run 54–67 min (median ~58), with 148 specs on at most 6 legs. The
queue's `check_response_timeout_minutes` is 60, so acceptance runs finishing past 60 min were thrown
out as `CI_TIMEOUT` with nothing red, and acceptance held a `max_entries_to_build` slot (§7.6) about
twice as long as the rest of the gate. The lane's specs are acceptance receipts, not a regression
suite (`CLAUDE.md`), and a spec change already ran on its own PR.

**Cost.** A change elsewhere that breaks an acceptance spec in the composed tree is now found after
the merge, instead of by ejection before it.

**Note 2026-11-02 (MOTIR-9412 · MOTIR-10277).** When this section was written, that after-the-merge
detector was the lane's `push: main` run. There is no push trigger any more: the whole acceptance and
regression lanes run against `main` once a night (`schedule`) and on a manual `workflow_dispatch`, and
a night that does not go green opens or comments on an `acceptance-nightly-red` issue assigned to a
named person (`.github/workflows/acceptance-nightly-notify.yml`). So the break is now found up to a
day after the merge, and its red names the range of merges since the last green night.
`docs/decisions/acceptance-video.md`, Amendment 2026-11-02, records the trade.
