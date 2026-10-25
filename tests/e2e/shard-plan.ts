// The bulk-leg shard plan (MOTIR-2617) — spec→leg membership derived from
// MEASURED per-spec cost, not from Playwright's `--shard=i/5` slice.
//
// WHY this exists. `--shard=i/N` partitions by test COUNT, keeping whole files
// together in DISCOVERY (alphabetical) order and slicing contiguously. Nothing
// about that slice knows what a spec costs, so the heaviest specs collect on
// whichever leg the alphabet drops them on, and nothing notices when a new spec
// joins the pile. Measured over two green `main` runs (below), the count-based
// split ran the five bulk legs at 159–280 s of test time — a 55 %-of-mean spread
// with the slowest leg carrying ~1.75× the fastest. That imbalance is the
// standing input to the `bulk-4` webServer-degradation flake (MOTIR-2617, three
// occurrences: PRs #1636 / #1912 / #2014): one runner accumulates the load, its
// `next start` server creeps over a memory/CPU cliff partway through the shard,
// and every navigation after that point hangs for the full 180 s test timeout.
//
// So membership is computed here instead: `SPEC_COST_SECONDS` records what each
// spec actually cost, and `assignBulkLegs` bin-packs those costs across the legs
// (longest-processing-time first — the standard greedy makespan heuristic,
// deterministic and total). On the same measurement the spread drops to <1 %.
//
// THE GUARD IS THE POINT. `tests/e2e-shard-plan.test.ts` asserts that every spec
// file the main Playwright config can run has a cost entry here. A new spec that
// nobody measured therefore fails the unit lane instead of silently landing on
// whichever leg the alphabet picks — which is exactly the failure mode above.
//
// Consumed by `playwright.config.ts` (E2E_SHARD=<leg id> → `testMatch`) and by
// the `e2e` matrix in `.github/workflows/ci.yml`. Deliberately dependency-free:
// the Playwright config imports it at module scope, and so does a vitest guard.

/** The bulk legs, in matrix order. */
export const BULK_LEG_IDS = [
  'bulk-1',
  'bulk-2',
  'bulk-3',
  'bulk-4',
  'bulk-5',
  'bulk-6',
  'bulk-7',
  'bulk-8',
] as const;

export type BulkLegId = (typeof BULK_LEG_IDS)[number];

/**
 * MEASURED per-spec cost, in seconds of test execution.
 *
 * Source: the `e2e-harness/*.jsonl` series of the five `playwright-report-bulk-*`
 * artifacts of run **33251966134** (2026-08-29, PR #2453, green), summing every
 * `test` record's `durationMs` per spec file. Playwright attributes hook time to
 * the test it runs for, so this includes each spec's seeding, not just its
 * assertions. One run, not an average of two — said plainly rather than dressed
 * up as the older method below.
 *
 * ⚠️ THE NUMBERS THIS REPLACED WERE FROM 2026-08-10 AND HAD DRIFTED FAR ENOUGH TO
 * MATTER (MOTIR-3913). The guard checks these costs against THEMSELVES — it
 * asserts the legs balance to within 15% of what this table says — so it stayed
 * green for nineteen days while reality moved. Net of each leg's pre-test boot,
 * the five legs actually ran 269 / 321 / 381 / 315 / 337 s: a 1.42x spread, not
 * the 1.007x the old table predicted. The two worst entries had moved by more
 * than a factor of two in OPPOSITE directions — `jobs-flow.spec.ts` 89.7 → 25.7 s
 * and `code-graph-refresh-engine.spec.ts` 26.0 → 56.6 s — which is why the drift
 * did not simply cancel. The lesson for whoever reads this next: a green guard is
 * not evidence this table is current, and only a run can tell you.
 *
 * `app-role-surfaces.spec.ts` moved 0 → 1.3 s, which is a category change rather
 * than drift: it now contributes tests to a bulk leg where it previously
 * contributed none. See the `0` paragraph below for why that distinction matters.
 *
 * A `0` is a real measurement, not a gap: those specs contribute NO tests to a
 * bulk leg because every test in them is selected away by the legs'
 * `--grep-invert "(board(-scrum)?|collab|epic6)-at-scale|@a11y"` — they belong to
 * the at-scale or @a11y legs. They are still assigned a bulk leg (Playwright
 * loads the file and finds nothing to run) so that "every spec file belongs to
 * exactly one leg" stays a total statement the guard can check.
 *
 * TO RE-MEASURE: download the `playwright-report-bulk-*` artifacts of a green
 * run and read the `e2e-harness/*.jsonl` series inside them — the harness
 * watchdog's `test` records carry a per-spec `durationMs` alongside the memory
 * samples, and summing those is what produced the numbers above. (The HTML
 * report in the same artifact shards its data across content-hashed files and is
 * the harder path to the same figures.) Re-measure whenever a leg's OBSERVED
 * test time drifts from what this table predicts — that comparison, not the
 * guard, is the thing that can tell you these numbers have aged.
 *
 * ⚠️ THE TWELVE SPECS PROMOTED BY MOTIR-2769 carry a DIFFERENT provenance, stated
 * so nobody averages them with the rest: they were measured LOCALLY, in one run
 * against a production build on 2026-08-13, because they had never run in this
 * lane before and a spec with no entry is assigned to no leg at all. They are
 * honest numbers for one machine, not the two-CI-run average above — expect CI
 * to differ, and re-measure them from the first green run that includes them.
 * `onboarding-migrate.spec.ts` (43.5 s) is by far the heaviest of the twelve and
 * is the one to watch when the bin-packer redistributes.
 *
 * ⚠️ `modal-scroll-container.spec.ts` (MOTIR-2491) carries the LOCAL provenance
 * too — a brand-new spec, three tests, each a sign-up + first project (one of
 * them a seeded sprint tree) and one short-viewport dialog. Measured on
 * 2026-09-05 against a production build on its own port and database, JSON
 * reporter, per-test `durationMs` summed: **5.6 s** (2.0 + 2.0 + 1.6) on a warm
 * server; the same three ran in 38–39 s of wall clock including harness
 * startup. Recorded as 6.0 — rounded UP, because under-estimating is the
 * direction that unbalances a bin-packer. Re-measure from the first green CI
 * run that includes it.
 *
 * ⚠️ `plan-decision-permission.spec.ts` (MOTIR-3188) carries the LOCAL provenance
 * too, for the same reason the twelve above do: it is a brand-new spec, and a
 * spec with no entry here is assigned to no leg and never runs — which is what
 * the guard caught on its first CI run. Measured on 2026-08-20 against a
 * production build, twice: **2.8 s** alone on a cold server and **1.8 s** in a
 * warm run beside two siblings. The HIGHER reading is recorded, because
 * under-estimating is the direction that unbalances a bin-packer.
 *
 * That same run is the CALIBRATION for every local number in this file, which
 * nothing had until now: `custom-roles.spec.ts` measured **8.3 s** locally
 * against **8.2 s** here, and `roles-permissions.spec.ts` **6.5 s** against
 * **9.3 s**. So a local reading is in the same units and runs at or below the CI
 * cost — never above it. Re-measure from the first green run that includes it.
 *
 * ⚠️ `plan-proposal-correction.spec.ts` (MOTIR-3543) carries the LOCAL provenance
 * too, and the guard caught it with no entry on its FIRST CI run — the failure
 * this file exists to make loud, working exactly as designed: the spec passed
 * locally and would have been assigned to no leg and never run.
 *
 * Measured on 2026-08-26 against a production build, on its own port and
 * database, THREE times: **14.7 s** on a cold server, then **7.4 s** and
 * **6.3 s** warm. The COLD reading is what is recorded, following
 * `plan-decision-permission.spec.ts` above — under-estimating is the direction
 * that unbalances a bin-packer, and this spec's first navigation compiles the
 * plan-detail route. The spread is wider than the others here because the spec
 * drives six MCP round trips interleaved with four page loads, so a warm run
 * saves proportionally more. Re-measure from the first green CI run that
 * includes it; expect something between the two.
 *
 * ⚠️ `cloud-follow-the-build-flow.spec.ts` (MOTIR-1117; MOVED to the cloud lane
 *    by MOTIR-4038, so it no longer carries a cost here) carries the LOCAL provenance
 * too, measured TWICE rather than the usual three times — said plainly rather
 * than dressed up as the usual method.
 *
 * Measured on 2026-08-27 against a production build, on its own port (3411) and
 * its own database, each on a COLD server: **3.3 s** and **3.4 s**, both
 * `1 passed (2.2m)` including harness startup. The two agree to within 0.1 s,
 * which is a tighter spread than any other local entry here — this spec has no
 * warm/cold gap to speak of because a production build compiles no route on
 * first hit, so the third reading the others needed to separate cold from warm
 * has nothing left to tell.
 *
 * Two EARLIER runs are not readings: both failed on defects in the spec itself
 * (an illegal `todo → done` seed transition, then an assertion that raced the
 * followed button's hover label), so their 1.3 s and 33.5 s measure a crash and
 * a 30-second locator timeout rather than the journey.
 *
 * 3.3 s is the FASTEST entry in this table, which is plausible for what it does
 * — two sign-ups and six navigations, no drag, no chart, no at-scale seed — but
 * it was measured on a box running several parallel sessions at load ~4, so the
 * readings are if anything pessimistic rather than flattering.
 *
 * **Re-measure from the first green CI run that includes it**, and expect a
 * higher number: the local readings above run at or below their CI cost, never
 * above it, and under-estimating is the direction that unbalances a bin-packer.
 *
 * ⚠️ `two-factor.spec.ts` (MOTIR-1223) carries the LOCAL provenance too, and the
 * guard caught it with no entry before it ever reached CI — which is this file
 * working as designed: the spec passed locally and would have been assigned to no
 * leg and never run.
 *
 * Measured on 2026-08-26 against a production build, on its own port (3217) and
 * its own database, THREE times: **13.3 s** on a cold server, then **12.6 s** and
 * **10.4 s** warm. The COLD reading is recorded, following the two entries above
 * — under-estimating is the direction that unbalances a bin-packer. The spread is
 * narrow because the spec's cost is dominated by six full sign-in journeys rather
 * than by first-hit route compilation; what a warm run saves is the enrol page's
 * initial compile, paid once.
 *
 * It is the heaviest new entry since `onboarding-migrate.spec.ts` and worth
 * watching when the bin-packer redistributes: six tests, each of which signs up,
 * enrols with a real RFC-6238 code, and signs in again.
 *
 * ⚠️ `jobs-fanout-engine.spec.ts` (MOTIR-3462) carries the LOCAL provenance too,
 * and for the reason the guard exists: a brand-new spec with no entry here is
 * assigned to no leg and never runs — which is exactly what the guard caught on
 * its first CI run. Measured on 2026-08-26 against a production build, on its
 * own lane with its own port and database: **4.7 s + 1.8 s + 1.8 s = 8.3 s** of
 * test time (the ~4.7 min wall is the build, which the legs pay once). Like the
 * others here, it is an honest number for one machine and one run — re-measure
 * it from the first green CI run that includes it.
 *
 * ⚠️ `jobs-postgres-engine.spec.ts` (MOTIR-3427) carries the LOCAL provenance
 * too, and it is a brand-new spec — the guard caught it with no entry on its
 * first CI run, which is exactly the failure this file exists to make loud: a
 * spec with no cost here is assigned to NO leg and never runs, so it would have
 * gone green by not executing.
 *
 * Measured on 2026-08-25 against a production build, TWICE, six tests each:
 * 18.2 s and 18.0 s of test bodies. Recorded as **22.0**, from the sum of the
 * per-test MAXIMA across the two runs (20.3 s) plus headroom — the higher
 * reading is the one to keep, because under-estimating is the direction that
 * unbalances a bin-packer, and the calibration note above says a local reading
 * runs at or below the CI cost.
 *
 * ⚠️ `project-repositories-api.spec.ts` (MOTIR-3591) carries the LOCAL
 * provenance too, and the guard caught it with no entry on its FIRST CI run —
 * the failure this file exists to make loud, working exactly as designed. It is
 * worth saying what that cost, because it is the sharpest instance yet: the spec
 * had been run locally and was green, the five bulk legs were green, and the
 * spec had run in NEITHER of them. A green bulk leg is not evidence that a new
 * spec ran.
 *
 * Measured on 2026-08-26 against a production build, on its own port and
 * database, twice: **3.2 s** on a cold server (1.7 + 0.9 + 0.5) and **1.8 s**
 * warm. The COLD reading is recorded, following the specs above — the first
 * request compiles the `/api/v1/projects/[projectKey]/repositories` route, and
 * under-estimating is the direction that unbalances a bin-packer. It is cheap
 * because it drives no browser: three bearer-authenticated HTTP reads and their
 * seeding, with no page load at all. Re-measure from the first green CI run that
 * includes it.
 *
 * ⚠️ `jobs-scheduled-engine.spec.ts` (MOTIR-3473) is the same story, one card
 * later — brand new, and the guard caught it with no entry on its first CI run.
 * Same LOCAL provenance, measured on 2026-08-25 against a production build.
 *
 * ⚠️ ITS 85.0 WAS A CEILING BOUGHT BY ONE SCENARIO, AND MOTIR-3314 REMOVED THAT
 * SCENARIO — so the entry is now **25.0**. The reasoning is kept rather than
 * replaced, because the ceiling argument is still right and only its input
 * changed.
 *
 * What made the old number a ceiling: the catch-up scenario waited for a REAL
 * `* * * * *` fire to pass on the scheduler's own watch — the only way to
 * observe the `skip` disposition through this lane — and that wait was uniformly
 * 0–60 s depending on where in the minute the spec started. Two back-to-back
 * runs against the same server MEASURED the swing directly: that scenario took
 * **10.1 s** in one and **51.0 s** in the next, 41 s from nothing but the wall
 * clock. Totals were 23.3 s and 61.8 s of test bodies.
 *
 * Clustering the crons left no per-minute job for it to wait on, so the scenario
 * was removed and its coverage moved to `tests/jobs/engine-scheduler.test.ts`
 * (see the removal note in the spec). **Subtracting it from the two measured
 * runs leaves 13.2 s and 10.8 s of test bodies** — the wall-clock swing was
 * entirely that scenario's, which is why the remainder is nearly a point value.
 * 25.0 keeps this file's own bias: round UP, because under-estimating is the
 * direction that unbalances a bin-packer, and a leg packed against the ceiling
 * is merely early.
 *
 * **This is DERIVED from the two recorded runs, not re-measured.** Re-measure
 * from the first green CI run that includes the change.
 *
 * ⚠️ IT NO LONGER RUNS A THIRD PROCESS. This spec used to start the Postgres job
 * engine's worker (`tests/e2e/_helpers/job-worker-process.ts`) for the scenario
 * above; nothing in it does now. That startup was paid ONCE in `globalSetup` and
 * never appeared in this per-spec cost either way.
 *
 * ⚠️ `shell-viewport-floor.spec.ts` (MOTIR-3208, re-measured for MOTIR-3286)
 * carries a FOURTH provenance: it had never run in this lane, so it was measured
 * LOCALLY against a production build on 2026-08-20 — three test BODIES at
 * 2.6 / 1.2 / 1.1 s (4.9 s total, sign-up and seeding included, since this spec
 * seeds inside the test rather than in a hook), rounded to 8.0 to cover the
 * three `resetDatabase()` hooks the reporter attributes separately.
 *
 * MOTIR-3286 added a FOURTH test (the containing-block leak) and re-measured the
 * same way on 2026-08-21: bodies at 2.3 / 1.1 / 0.7 / 0.7 s = **4.8 s**. The
 * bodies did not grow — the new test is one of the cheap ones and the run was
 * warmer — but there is now a fourth hook, and the 8.0 entry priced hooks at
 * (8.0 − 4.9) / 3 ≈ 1.03 s each. 4.8 + 4 × 1.03 ≈ 8.9, recorded as **9.5**:
 * rounding UP is the safe direction, because under-estimating is what unbalances
 * a bin-packer. Re-measure it from the first green CI run that includes it.
 *
 * ⚠️ `app-role-surfaces.spec.ts` (MOTIR-2816) carries a THIRD provenance and a
 * cost of ~0 that is honest for THIS lane and misleading anywhere else. Every
 * test in it calls `test.skip()` unless `E2E_APP_ROLE=1`, and the bulk legs never
 * set that — so in this lane it loads, skips seven tests and contributes no
 * execution time. Under its own harness it is a full sign-in-plus-seven-surfaces
 * pass (measured locally at ~95 s). Re-measure it here only if the flag ever
 * becomes the lane default; until then a real number would be a lie about what
 * the bin-packer is scheduling.
 *
 * ⚠️ `auth-signed-in-bounce.spec.ts` (MOTIR-3372) carries the LOCAL provenance
 * too, and it is here because the guard caught it: a spec with no entry is
 * assigned to no leg, so its first CI run executed it ZERO times while every
 * check went green about it. Measured on 2026-08-21 against a production build
 * on a private cluster, twice: **3.6 s** wall for the file on the first run, and
 * **1.51 s** of test BODIES (1.155 + 0.351) on a warm second run. The gap is the
 * two `resetDatabase()` hooks the reporter attributes separately — ≈1.05 s each,
 * which agrees with the ≈1.03 s/hook figure `shell-viewport-floor` derived above.
 * Recorded as **4.5**: the higher reading, rounded UP, because under-estimating
 * is the direction that unbalances the bin-packer and a local number runs at or
 * below the CI cost. Re-measure from the first green run that includes it.
 *
 * ⚠️ `cascade-under-load.spec.ts` (MOTIR-3767) carries the LOCAL provenance too,
 * and it is the guard's fifth catch — brand new, so with no entry here it would
 * have been assigned to no leg and gone green by never executing.
 *
 * Measured on 2026-08-28 against a production build, on a private lane with its
 * own port, its own database and its own job worker. Body: **2.5 s**; wall-clock
 * over the file **2.0 m including the production build**. Recorded as **5.0** — the body plus the hooks the
 * reporter attributes separately, rounded UP, for this file's standing reason:
 * under-estimating is the direction that unbalances the bin-packer, and a local
 * number runs at or below the CI cost.
 *
 * ⚠️ `supervision-pool-under-load.spec.ts` (MOTIR-3832) carries the same
 * provenance, and it is the guard's sixth catch — brand new, so with no entry
 * here it would have been assigned to no leg and gone green by never executing.
 *
 * Measured on 2026-08-28 against a production build, on a private lane with its
 * own port, its own database and its own job worker — FOUR consecutive green
 * runs. Bodies: **4.6 s** and **5.8 s**; wall-clock over the file 21–29 s
 * including `globalSetup`'s worker start. Recorded as **11.0** — the higher body
 * plus the hooks the reporter attributes separately, rounded UP, for this file's
 * standing reason.
 *
 * ⚠️ IT COSTS MORE THAN ITS SIBLING BECAUSE IT FILLS THE POOL. `cascade-under-load`
 * needs ONE long run beside the fast lane; this one needs `POOL_SIZE` of them,
 * because after MOTIR-3762 a single supervisor detains only its own slot and a
 * one-probe spec would pass on the pre-change worker. Ten probes each cycling on
 * a 250 ms defer is what makes the assertion discriminate, and it is where the
 * extra seconds go.
 *
 * ⚠️ AND THE NUMBER IS ONLY THIS SMALL BECAUSE THE LONG JOB ENDS ON A SIGNAL.
 * The spec needs a run that is still in flight when the cascade lands, and the
 * obvious shape — a job that sleeps for a fixed duration — would have to outlast
 * the cascade's own latency on the SLOWEST runner, so it would cost that
 * worst-case every time it ran. `lib/test-slow-job.ts` waits for a release row
 * the spec writes after asserting instead, so the run costs what the assertions
 * cost and the ordering is pinned rather than raced. Its 30 s clamp is a runaway
 * guard for a spec that dies mid-assertion, never the expected duration.
 *
 * ⚠️ `code-graph-refresh-engine.spec.ts` and `code-graph-writer-seam.spec.ts`
 * (MOTIR-3417) carry the LOCAL provenance too, and they are the guard's fourth
 * catch: both are brand new, so on their first CI run they had no entry here,
 * were assigned to no leg, and would have gone green by never executing.
 *
 * Measured on 2026-08-26 against a production build, on a private lane with its
 * own port, its own database and its own job worker, TWICE. Bodies:
 * **5.2 / 5.1 / 4.9 / 4.9 s** and **5.3 / 4.5 / 5.2 / 4.8 s** for the four
 * refresh-engine tests, and **4.7 s** then **4.4 s** for the writer seam. The
 * sums of per-test MAXIMA are 20.5 s and 4.7 s; wall-clock over the pair was
 * 28.3 s and 26.7 s, so the hooks the reporter attributes separately cost
 * ≈0.7 s per test here. Recorded as **26.0** and **6.5** — maxima plus hooks,
 * rounded UP, for this file's standing reason: under-estimating is the direction
 * that unbalances a bin-packer.
 *
 * ⚠️ AND THESE TWO NUMBERS ARE ONLY HONEST BECAUSE THE SPECS STOPPED SLEEPING.
 * `system.code-graph-refresh` declares `debounce: { period: '2m' }`, and a
 * SIGKILLed worker holds its claim for `LEASE_MS` (60 s). Written the obvious
 * way — waiting both out — the same five tests measured **522 s** and **132 s**,
 * i.e. one spec alone would have exceeded the whole 160–280 s budget of the leg
 * it landed on and recreated the `bulk-4` imbalance this plan exists to remove.
 * Nothing was weakened to get here: each spec ASSERTS the window where it is a
 * claim (`run_at` really is `period` past the last arrival, and nothing has run
 * while it is open) and then expresses it as STATE where it is only a delay, by
 * moving `run_at` into the past. The two durations are asserted BY VALUE, in
 * `tests/jobs/supervisor-cutover-story-gate.test.ts`.
 *
 * So a long declared wait is not a reason to record a large cost here — it is a
 * reason to check whether the spec is asserting the wait or merely serving it.
 * Re-measure both from the first green CI run that includes them.
 *
 * ⚠️ `passkeys.spec.ts` (MOTIR-3615) carries the LOCAL provenance too, and the
 * guard would have caught it with no entry before it reached CI — the spec
 * passed locally and would have been assigned to no leg and never run.
 *
 * Measured on 2026-08-26 against a production build, on its own port (3177) and
 * its own database, THREE times: **3.8 s**, **4.2 s** and **4.7 s** of TEST time
 * (2.2/2.4/2.9 s for the journey, then ~0.9 s apiece for the two refusals). The
 * HIGHEST is recorded, following the entries above — under-estimating is the
 * direction that unbalances a bin-packer.
 *
 * ⚠️ AND THE WALL CLOCK IS NOT THE COST. Each of those runs took ~2 minutes end
 * to end, essentially all of it the `webServer`'s own `next build` — a fixed
 * cost every lane pays once, not this spec's. Reading the wall clock would have
 * recorded ~115 s here, roughly nine times the heaviest real entry, and the
 * bin-packer would have built a leg around a number that does not exist. Take
 * the per-test durations the `list` reporter prints, never the summary line.
 *
 * It is cheap for what it does because the ceremonies are virtual: a CDP
 * authenticator answers instantly, where the 2FA spec pays for six real sign-in
 * journeys.
 *
 * ⚠️ `data-subject-request-journey.spec.ts` (MOTIR-3706) carries the LOCAL
 * provenance too, and the entry arrives WITH the spec rather than after a red
 * CI run — which is what the guard above would otherwise have caught: a spec
 * with no cost here is assigned to NO leg and never runs.
 *
 * Measured on 2026-08-28 against a production build, on its own port (3406) and
 * its own scratch database, TWICE — three tests each, both `3 passed`. Only the
 * SECOND run is a per-test reading (the first was taken with the `line`
 * reporter, which prints the summary and nothing else), so what the first
 * contributes is the pass and not a number. Said plainly rather than averaged
 * in. The readings: **2.8 s + 0.9 s + 0.8 s = 4.5 s** of test bodies.
 *
 * Recorded as **6.0**, the measurement plus headroom, following
 * `jobs-postgres-engine.spec.ts` above — under-estimating is the direction that
 * unbalances a bin-packer, and the calibration note says a local reading runs at
 * or below its CI cost.
 *
 * The deletion journey is the heavy one of the three and its cost is where you
 * would expect: it pays for a sign-UP and then a sign-IN, because the flow it
 * walks deliberately signs the reader out halfway through. The other two are a
 * single navigation each. Re-measure from the first green CI run that includes
 * it.
 *
 * ⚠️ `legal-gone-selfhost.spec.ts` (MOTIR-4105) is new, with the same LOCAL
 * provenance as the three above. Measured on 2026-09-03 against a production
 * build on port 3000, FOUR consecutive runs, `1 passed` every time: **1.5 s,
 * 1.1 s, 0.9 s, 1.1 s** of test body. The four are a deliberate no-flake check
 * the card asked for, not a search for a best case — so the number recorded is
 * the **COLDEST** (1.5 s), following every spec above, because under-estimating
 * is the direction that unbalances a bin-packer.
 *
 * Recorded as **3.0**: the cold reading plus headroom, and in line with its
 * nearest neighbour by shape — `billing-selfhost.spec.ts` at 2.7, which is the
 * same kind of spec (the self-host arm of a capability, driven in the main lane
 * because `playwright.config.ts` IS that arm). It is cheap because five of its
 * assertions are bare HTTP reads with no page load; what it pays for is the one
 * sign-up. Re-measure from the first green CI run that includes it.
 *
 * ⚠️ `hero-ai-control-styles.spec.ts` (MOTIR-4743) carries the LOCAL provenance
 * too, and the guard caught it with no entry on its FIRST CI run — the failure
 * this file exists to make loud, working exactly as designed. Worth stating
 * plainly, because of what the spec IS: it is the only evidence for two of its
 * card's acceptance criteria (every registered style's hero treatment, measured
 * in a browser against the base style). It passed locally, forty-seven other
 * checks went green, and it would have been assigned to no leg and never run.
 * A green bulk leg is not evidence that a new spec ran.
 *
 * Measured on 2026-09-06 against a production build, on its own port (3743) and
 * its own database, THREE times: **5.3 s** on a cold server, then **7.5 s** and
 * **7.9 s** warm. Recorded as **8.0** — the highest reading, rounded up.
 *
 * ⚠️ THE COLD READING IS THE LOWEST ONE HERE, WHICH INVERTS THE PATTERN EVERY
 * ENTRY ABOVE DESCRIBES, and the reason matters for whoever measures the next
 * spec. Those entries record the cold reading BECAUSE a first navigation
 * compiles a route; against a production build it compiles nothing, which
 * `cloud-follow-the-build-flow.spec.ts` already observed ("this spec has no
 * warm/cold gap to speak of"). So there is no cold penalty to pay here, and the
 * 5.3 → 7.9 spread is BOX LOAD, not warmth: the readings were taken on a machine
 * running several parallel sessions at load average 5.0. Follow the file's rule
 * rather than its examples — record the HIGHEST reading, because
 * under-estimating is the direction that unbalances a bin-packer.
 *
 * It is cheap for a spec that drives eleven style switches twice over because it
 * runs on `/tokens`, which is public: no sign-up, no seeding, no
 * `resetDatabase()` hook. The four test bodies are 0.6 / 1.7 / 1.5 / 1.5 s and
 * the ~100 s wall clock is the build, which the legs pay once.
 *
 * ⚠️ RE-MEASURED FROM CI, which is what every entry above asks for and almost
 * none of them has had done. Run **34065849062** (2026-09-06, PR #2669, green)
 * ran it on `bulk-6` at **1.2 / 3.8 / 3.4 / 3.3 s = 11.7 s**, and the entry is
 * now **12.0**. The local readings were 5.3 / 7.5 / 7.9 — so CI costs about 1.5x
 * the best local one, and the calibration note above holds exactly as written: a
 * local reading runs at or below the CI cost, never above it. Recorded from the
 * CI figure rather than the local one, because that is the number the
 * bin-packer is actually packing.
 */
export const SPEC_COST_SECONDS: Readonly<Record<string, number>> = {
  // MOTIR-4094 — promoted receipt specs, ESTIMATED for their first main-lane
  // run. The acceptance lane's human pacing is removed by
  // `_helpers/promoted-regression`, so its video wall time is not a usable
  // measurement. These are conservative, complexity-relative first-run costs;
  // replace them from the first green bulk artifacts, as for every new entry.
  'agent-authored-plan.spec.ts': 18.0,
  // Bug MOTIR-5782 · MOTIR-5796 — PROMOTED out of the acceptance lane (it was
  // `acceptance-agent-folder-placement.spec.ts`, MOTIR-5310's receipt; the
  // disposition is in docs/acceptance-lane-triage.md). Two tests: an integration
  // files over /api/v1, an agent proposes into the folder over the MCP, a reviewer
  // approves it into place; and the deleted-folder refusal. MEASURED locally on
  // 2026-09-19 against a PRODUCTION build (list reporter, the tests' own times):
  // 5.5 s + 2.0 s = **7.5 s**, warm — recorded as **15.0**, rounded UP for the
  // lane's slower runner because under-estimating is the direction that unbalances
  // a bin-packer. RE-MEASURE from the first green bulk artifact that includes it.
  'agent-folder-placement.spec.ts': 15.0,
  'activity.spec.ts': 13.8,
  // Story MOTIR-4337 · Subtask MOTIR-4566 — the operator's org lookup and org
  // page, plus the 404 a tenant user gets on both. MEASURED locally on
  // 2026-09-06 against a production build in this lane: **1.7 s** of test body,
  // `1 passed`. ONE reading, said plainly — recorded as **3.0**, the reading
  // plus headroom and in line with its nearest neighbour by shape
  // (`billing-selfhost.spec.ts` at 2.7: one sign-up, then assertions that are
  // mostly bare HTTP reads). RE-MEASURE from the first green bulk artifact that
  // includes it, as for every new entry.
  //
  // ⚠️ AND ITS ABSENCE FROM THIS TABLE WAS NOT FREE. The spec shipped without an
  // entry, so it was assigned to no leg and never ran — and it was RED: an
  // unscoped `getByRole('button', { name: 'Search' })` also matched the admin
  // shell's disabled global-search button, a strict-mode violation nothing could
  // report while the spec was unreachable. This guard is what found it, which is
  // the case it exists for.
  'admin-org-lookup.spec.ts': 3.0,
  // Story MOTIR-6905 · MOTIR-7322 — the fleet monitor's OFF-CLOUD arm: one
  // sign-up, then two page loads asserting the disabled card and the absent Stop.
  // ESTIMATED from its nearest neighbour by shape (`admin-org-lookup.spec.ts`,
  // above) plus the measured local reading below, rounded UP because
  // under-estimating unbalances the bin-packer. RE-MEASURE from the first green
  // bulk artifact that includes it.
  'admin-fleet-selfhost.spec.ts': 4.0,
  // Story MOTIR-7664 · MOTIR-7680 — the Ideas console smoke: one sign-up, the
  // list, one detail and the tenant 404. ESTIMATED from its nearest neighbour by
  // shape (`admin-fleet-selfhost.spec.ts`, above), rounded UP for the same
  // reason. RE-MEASURE from the first green bulk artifact that includes it.
  'admin-ideas-smoke.spec.ts': 4.0,
  'app-role-surfaces.spec.ts': 1.3,
  'ai-callout-gate.spec.ts': 1.9,
  'ai-plan-generation.spec.ts': 10.0,
  'api-tokens.spec.ts': 29.2,
  'appearance-sync.spec.ts': 7.0,
  'archive-flow.spec.ts': 14.7,
  'attachments.spec.ts': 21.1,
  'auth-credentials.spec.ts': 5.4,
  'auth-google.spec.ts': 4.2,
  'auth-post-auth-landing.spec.ts': 4.2,
  'auth-signed-in-bounce.spec.ts': 4.3,
  'automation.spec.ts': 12.8,
  'backlog-filter.spec.ts': 4.0,
  'backlog.spec.ts': 23.6,
  'billing-selfhost.spec.ts': 2.7,
  'board-a11y.spec.ts': 0,
  'board-at-scale-interaction.spec.ts': 0,
  'board-at-scale.spec.ts': 0,
  'board-config.spec.ts': 15.1,
  'board-crud.spec.ts': 24.9,
  'board-filter.spec.ts': 4.5,
  'board-load.spec.ts': 7.5,
  'board-projection.spec.ts': 10.9,
  'board-scrum-at-scale-interaction.spec.ts': 0,
  'board-scrum-at-scale.spec.ts': 0,
  'board-scrum.spec.ts': 14.0,
  'board-swimlanes.spec.ts': 16.9,
  'board-ui.spec.ts': 43.5,
  // MOTIR-4940 — new file, so no green `main` run to read `result.duration` from:
  // a floor estimated from its six steps (two room visits with a save and a reload,
  // a folder create, two filed bugs read back in /items). Re-measure from the
  // artifacts on the next green run, as this file's header prescribes.
  'bug-destination.spec.ts': 30.0,
  'canvas-detail.spec.ts': 6.1,
  'cascade-under-load.spec.ts': 3.7,
  'charts.spec.ts': 9.7,
  'child-panel-graph.spec.ts': 7.5,
  'cli-connect.spec.ts': 17.2,
  'code-graph-refresh-engine.spec.ts': 56.6,
  'code-graph-writer-seam.spec.ts': 14.8,
  // ⚠️ AN ESTIMATE, NOT A MEASUREMENT, and said so rather than blended into the
  // table above. `code-index-freshness.spec.ts` (MOTIR-1771) has never run in
  // this lane, and a spec with no entry is assigned to no leg at all — so an
  // honest guess that makes it RUN beats an accurate silence that does not.
  // Sized from its shape: seven cases, each a sign-up plus a small seed and one
  // or two page loads, which is the expensive part. RE-MEASURE from the first
  // green run that includes it, per this file's own instructions.
  'code-index-freshness.spec.ts': 35.0,
  'collab-at-scale.spec.ts': 0,
  'collab-journey.spec.ts': 11.4,
  'comments.spec.ts': 12.1,
  'custom-fields.spec.ts': 20.6,
  'custom-roles.spec.ts': 16.0,
  'data-subject-request-journey.spec.ts': 8.5,
  'delivery-set.spec.ts': 12.0,
  'dashboards.spec.ts': 13.9,
  // MOTIR-5118. Measured LOCALLY (3.3 s + 1.5 s over the two tests, on this
  // box), not from a green CI run — there is no CI run of it yet, and the
  // header's own instruction is to re-measure from the next green
  // `playwright-report-bulk-*` artifact. A local number is the honest
  // placeholder; a 0 would not be, since 0 in this table means *contributes no
  // tests to a bulk leg*, which is false of this spec.
  'approval-gate-repaint.spec.ts': 4.8,
  // MOTIR-5224 — the approval overlay's smoke. Measured LOCALLY (2.8 s, one test,
  // against a production build), not from a green CI run — there is none yet.
  // Re-measure from the first green `playwright-report-bulk-*` artifact with it.
  'approval-overlay.spec.ts': 2.8,
  // MOTIR-6042 — the acceptance recording fits the overlay at three viewports.
  // Measured LOCALLY against a production build (3.5 s + 4.0 s over two tests,
  // warm), not from a green CI run — there is none yet. Recorded at ~1.5x, per the
  // calibration note, since a local reading runs at or below the CI cost.
  // Re-measure from the first green `playwright-report-bulk-*` artifact with it.
  'approval-overlay-video-fits.spec.ts': 11.0,
  // MOTIR-5724, completed by MOTIR-5726. BOTH promoted out of the acceptance lane
  // by MOTIR-5724 (they were `acceptance-approval-overlay.spec.ts` and
  // `acceptance-approvals-tab.spec.ts`), which is why they arrive here together.
  //
  // ⚠️ AN ENTRY IS NOT PAPERWORK FOR THESE TWO — it is whether they run at all.
  // A promoted spec with no cost is assigned to NO leg, so the promotion had
  // silently stopped them executing: green on every shard, and green because
  // nothing ran them. `tests/e2e-shard-plan.test.ts` is the guard that said so,
  // and it is the reason this pair is recorded before the branch merges.
  //
  // MEASURED LOCALLY against a production build, all tests passing in THIS lane
  // (7 passed, 7.5m wall including the build):
  //   approval-overlay-walk  8.9 + 2.1 + 2.9 = 13.9 s over three tests
  //   approvals-tab          3.9 + 1.7 + 2.2 + 3.0 = 10.8 s over four
  // Recorded at the ~1.5x this file's own calibration note puts between a local
  // reading and the CI cost the bin-packer is packing — 21.0 and 16.0 — rather
  // than at the local figure, which that note says runs at or below CI and never
  // above it. Their acceptance-lane runtimes (~94 s and ~54 s) are NOT
  // comparable: that was the receipts' `chapter()` / `beat()` pacing, which
  // `_helpers/promoted-regression` removes. Re-measure both from the first green
  // `playwright-report-bulk-*` artifact that includes them.
  'approval-overlay-walk.spec.ts': 21.0,
  'approvals-tab.spec.ts': 16.0,
  // Story MOTIR-6070 — PROMOTED out of the acceptance lane (it was
  // `acceptance-refusal-reason.spec.ts`, MOTIR-6067's receipt; the disposition is in
  // docs/acceptance-lane-triage.md). One test: a design, a choice and a set of pull
  // requests sent back with a reason, read back on the overlay, the item page and the
  // Approvals room. MEASURED locally on 2026-09-26 against a production build in THIS
  // lane (list reporter, `1 passed`): **28.7 s**, cold — much of it the three reasons
  // typed at 12 ms a key. Recorded at the ~1.5x this file's calibration note puts
  // between a local reading and the CI cost: **43.0**. RE-MEASURE from the first green
  // `playwright-report-bulk-*` artifact that includes it.
  'density-nested-scope.spec.ts': 3.0,
  'density-style-swap.spec.ts': 6.0,
  'refusal-reason.spec.ts': 43.0,
  // Story MOTIR-7460 — three receipts PROMOTED out of the acceptance lane when the
  // Workbench's To approve tab was renamed Waiting on you (they were
  // `acceptance-approvals-room.spec.ts`, `acceptance-plain-words-approvals.spec.ts`
  // and `acceptance-workbench.spec.ts`; the dispositions are in
  // docs/acceptance-lane-triage.md § MOTIR-7460). MEASURED locally on 2026-10-04
  // against a production build in THIS lane (list reporter, `6 passed`):
  //   approvals-room          18.4 + 7.0  = 25.4 s over two tests
  //   plain-words-approvals   18.4 + 11.6 = 30.0 s over two
  //   workbench-lifecycle     10.7 + 3.6  = 14.3 s over two
  // Recorded at the ~1.5x this file's calibration note puts between a local reading
  // and the CI cost. RE-MEASURE from the first green `playwright-report-bulk-*`
  // artifact that includes them.
  'approvals-room.spec.ts': 38.0,
  'plain-words-approvals.spec.ts': 45.0,
  'workbench-lifecycle.spec.ts': 21.5,
  // MOTIR-5306. Promoted from the acceptance lane (it was
  // `acceptance-design-approval.spec.ts`). Measured LOCALLY (4.2 s, one test,
  // against a production build), not from a green CI run — there is none in this
  // lane yet. Its acceptance-lane runtime (~40 s) is not comparable: that was the
  // receipt's `beat()` pacing, which the promotion removed. Re-measure from the
  // first green `playwright-report-bulk-*` artifact that includes it.
  'design-approval.spec.ts': 4.2,
  // MOTIR-5559 — a done design is final: approve, republish refused, reopen,
  // republish accepted. Measured LOCALLY against a production build (5.0 s cold,
  // then 2.9 s and 2.4 s; one test), not from a green CI run — there is none yet.
  // Re-measure from the first green `playwright-report-bulk-*` artifact with it.
  'design-card-closed.spec.ts': 5.0,
  'design-result.spec.ts': 9.2,
  'design-result-publish.spec.ts': 8.0,
  'epic2-acceptance.spec.ts': 7.4,
  'epic6-at-scale.spec.ts': 0,
  'epic6-journey.spec.ts': 14.4,
  'estimation.spec.ts': 14.6,
  'filter-builder.spec.ts': 23.8,
  // Story MOTIR-5753 PROMOTED this from the acceptance lane (it was
  // `acceptance-folders.spec.ts`, Story MOTIR-5308's receipt). ESTIMATED, not
  // measured — two tests: the folder walk over /items, /boards and /backlog, and
  // the viewer's look. Rounded UP; re-measure from its first green bulk leg.
  'folders-tidy.spec.ts': 30.0,
  'github.spec.ts': 8.3,
  'general-attachment.spec.ts': 8.0,
  'gitlab.spec.ts': 6.1,
  // MOTIR-7134 — /code for a repository refused for size. Measured LOCALLY (6 tests,
  // 20.4 s against a production build), not from a green CI run — there is none yet.
  // Recorded at ~1.5x per the calibration note. Re-measure from the first green
  // `playwright-report-bulk-*` artifact with it.
  'graph-too-large.spec.ts': 30.0,
  // MOTIR-7693 — framed scroll containers under hand-drawn-indie, on the public
  // /tokens page (no sign-up). Measured LOCALLY (1 test, 1.8 s against `next dev`),
  // not from a green CI run. Rounded UP; re-measure from its first green bulk leg.
  'hand-drawn-scroll-frame.spec.ts': 5.0,
  'hero-ai-control-styles.spec.ts': 12.0,
  // MOTIR-5487. Promoted from the acceptance lane (it was
  // `acceptance-how-to-test.spec.ts`). NOT measured in this lane: estimated from the
  // acceptance run's per-step timings (CI run 34950375290) with the receipt's
  // `beat()` holds removed — ~2.4 s seed, ~1.4 s sign-in, ~2.4 s over the first
  // three steps, ~3 s for the last three. Re-measure from the first green
  // `playwright-report-bulk-*` artifact that includes it.
  'how-to-test.spec.ts': 9.2,
  // MOTIR-7761 — nine languages × seven surfaces, ESTIMATED from a local
  // production-build run (2026-10-08: 8.6–14.5 s per language, ~90 s summed,
  // seed included) and rounded UP to 120.0 because under-estimating unbalances
  // the bin-packer. Re-measure from the first green CI run that includes it.
  'i18n-locale-walk.spec.ts': 120.0,
  'workbench.spec.ts': 10.9,
  'import.spec.ts': 9.1,
  'implemented-lifecycle.spec.ts': 16.0,
  'issue-create-edit-flow.spec.ts': 16.7,
  'issue-detail-flow.spec.ts': 51.7,
  // MOTIR-5547 AC 7 — the plan-history section's smoke on `/items/<key>`. A
  // brand-new spec, ESTIMATED rather than measured: it runs the same
  // `seedPlanShapes` as `plan-shapes.spec.ts` (14.0 s) plus three page loads, so
  // 16.0, rounded UP because under-estimating unbalances the bin-packer.
  // Re-measure from the first green CI run that includes it.
  // MOTIR-5549 adds a second test (its `seedPlanHistory` approves and declines
  // six plans, then three page loads across two sign-ins), ESTIMATED at +14 s on
  // the same basis — so 30.0, again rounded up.
  'item-plan-history.spec.ts': 30.0,
  'issue-list-flow.spec.ts': 51.7,
  'jobs-dashboard.spec.ts': 8.6,
  'jobs-fanout-engine.spec.ts': 11.7,
  'jobs-flow.spec.ts': 25.7,
  'jobs-postgres-engine.spec.ts': 24.8,
  'jobs-scheduled-engine.spec.ts': 14.6,
  // MOTIR-7759 / MOTIR-7761 — ten tests (eight locales at 1280×800, two at
  // 768×1024), each a sign-in and a walk of eleven surfaces with their menus.
  // Measured LOCALLY against a production build on 2026-10-08, JSON reporter,
  // per-test `durationMs` summed (seed included): 118.4 s alone and 113.8 s
  // beside `i18n-locale-walk.spec.ts`. The higher reading, rounded UP to 120.0,
  // because under-estimating unbalances the bin-packer. Re-measure from the
  // first green CI run that includes it.
  'label-fit-long-locales.spec.ts': 120.0,
  'labels-components-watch.spec.ts': 28.5,
  // MOTIR-6564 — ESTIMATED, not measured: seven serial cases, ten sign-ins and a
  // workspace created through the UI; priced from `workspace-flows.spec.ts`'s
  // per-sign-in cost and rounded UP. Replace with its measured CI time.
  'legacy-role-storage.spec.ts': 60.0,
  'legal-gone-selfhost.spec.ts': 3.0,
  'link-search-flow.spec.ts': 14.6,
  'member-facing-permissions.spec.ts': 7.7,
  // MOTIR-7004 — a brand-new spec, ESTIMATED rather than measured: no browser
  // page at all, two seeds, two MCP sessions and a handful of tool calls plus
  // one catalogue GET. Rounded UP, because under-estimating unbalances the
  // bin-packer. Re-measure from the first green CI run that includes it.
  'mcp-tool-hints.spec.ts': 8.0,
  'migrate-index-fleet.spec.ts': 26.7,
  // MOTIR-8774 — a brand-new spec, ESTIMATED rather than measured: three tests,
  // each a sign-up, a project and the migrate walk to Import, the shape
  // `migrate-index-fleet.spec.ts` (26.7 s) runs, plus Enter Motir's navigation.
  // Rounded UP, because under-estimating unbalances the bin-packer. Re-measure
  // from the first green CI run that includes it.
  'migrate-nonblocking-index.spec.ts': 35.0,
  'modal-scroll-container.spec.ts': 6.0,
  'multi-tenant-isolation.spec.ts': 2.5,
  'navigation-instant.spec.ts': 8.0,
  // MOTIR-4708 — one sign-up + project, then four theme x OS passes over the
  // 404 route. Estimated from `appearance-sync.spec.ts` (7.0 s: the same sign-up
  // and the same PATCH-awaited toggle) plus three extra navigations; re-measure
  // it from a green run's `e2e-harness/*.jsonl` when this table is next refreshed.
  'not-found-theme.spec.ts': 9.0,
  'notifications.spec.ts': 14.3,
  // MOTIR-6985: an estimate, not a measurement — sign-up, one project, one
  // authorize → consent → approve round trip. Re-measure from the first green run.
  // MOTIR-6988: measured locally on a production build — four tests at 6.6 s,
  // 4.5 s, 2.7 s and 3.8 s, plus each test's reset and seed. Re-measure from a
  // green run's `e2e-harness/*.jsonl` when this table is next refreshed.
  'oauth-connect.spec.ts': 22.0,
  'oauth-consent.spec.ts': 15.0,
  'onboarding-discovery.spec.ts': 2.6,
  'onboarding-entrance.spec.ts': 6.8,
  'onboarding-entry.spec.ts': 2.9,
  'onboarding-fresh.spec.ts': 9.3,
  // MOTIR-8257 — a brand-new spec, ESTIMATED rather than measured: one sign-up,
  // then nine tests that each open a context and load four onboarding screens.
  // Rounded UP; re-measure from the first green bulk leg that includes it.
  'onboarding-locale-sweep.spec.ts': 60.0,
  'onboarding-migrate.spec.ts': 42.0,
  'onboarding-ran-gate.spec.ts': 14.1,
  // MOTIR-7280 — a brand-new spec, ESTIMATED rather than measured: two tests,
  // a sign-up each; the first creates a page over HTTP, renames it, types a line
  // and reloads, the second reads one 404. Rounded UP, because under-estimating
  // unbalances the bin-packer. RE-MEASURE from the first green CI run that
  // includes it.
  // MOTIR-7414 — ESTIMATED, not measured: one test — a sign-up, an MCP create,
  // three page loads, one debounced save and four tool calls. Rounded UP;
  // re-measure from its first green bulk leg.
  'pages-agent-mcp.spec.ts': 25.0,
  // MOTIR-9555 — ESTIMATED, not measured: one test — a sign-in, one tree load and
  // archive, about fifteen REST calls and two MCP sessions. Rounded UP; re-measure
  // from its first green bulk leg.
  'pages-search.spec.ts': 20.0,
  'pages-smoke.spec.ts': 20.0,
  'pages-stream.spec.ts': 12.0,
  // MOTIR-7376 — ESTIMATED, not measured: three tests, a sign-up each; the
  // third seeds a ten-page chain and expands nine levels before its drag. Rounded
  // UP; re-measure from its first green bulk leg.
  'pages-tree-drag.spec.ts': 35.0,
  // Story MOTIR-5753 PROMOTED this from the acceptance lane (it was
  // `acceptance-pages.spec.ts`, Story MOTIR-5752's receipt). ESTIMATED, not
  // measured — four tests: the typed walk with ~7 debounced saves and a second
  // session, then the 404, offline and too-large states. Rounded UP; re-measure
  // from its first green bulk leg.
  'pages-write.spec.ts': 45.0,
  'org-admin.spec.ts': 8.6,
  // MOTIR-6405 — measured LOCALLY in one run (47.0 s wall, which includes the
  // server's first compile of the routes it opens), so an upper bound:
  // re-measure from its first green CI leg.
  'org-deletion.spec.ts': 47.0,
  'per-domain-admin-permissions.spec.ts': 12.4,
  'permission-gated-surfaces.spec.ts': 18.0,
  'permission-gated-ui.spec.ts': 14.0,
  'plan-change-planner-turn.spec.ts': 7.6,
  'plan-decision-permission.spec.ts': 4.5,
  'plan-detail-refined.spec.ts': 10.0,
  // Bug MOTIR-6697 (Story MOTIR-6577) — PROMOTED out of the acceptance lane (it was
  // `acceptance-plan-difficulty.spec.ts`, MOTIR-6095's receipt; the disposition is in
  // docs/acceptance-lane-triage.md). Two tests: an agent-authored plan read on the
  // list, the peek and the canvas, approved, and read back on two item pages; and a
  // plan with no difficulty at all. ESTIMATED, not measured — the run that promoted
  // it built no production bundle: the same `seedAgentAuthoredPlan` +
  // `authorPlanOverMcp` as `agent-authored-plan.spec.ts` (18.0) with more page
  // loads (six peeks, two item pages, the second test's three views). Rounded UP,
  // because under-estimating unbalances the bin-packer. RE-MEASURE from the first
  // green `playwright-report-bulk-*` artifact that includes it.
  'plan-difficulty.spec.ts': 30.0,
  // MOTIR-6281 — a brand-new spec, ESTIMATED rather than measured: one
  // `seedPlanShapes` (the bulk of `plan-shapes.spec.ts`'s 14.0 s), one sign-in and
  // one plan-page load at two widths. Rounded UP, because under-estimating
  // unbalances the bin-packer. Re-measure from the first green CI run that
  // includes it.
  'plan-detail-narrow.spec.ts': 14.0,
  'plan-proposal-correction.spec.ts': 4.4,
  'plan-shapes.spec.ts': 14.0,
  'plan-timeline.spec.ts': 14.0,
  // MOTIR-5828 — a brand-new spec, so there is no green `main` run to read
  // `result.duration` from, and the guard caught it with no entry on its FIRST CI
  // run: a spec nobody measured is assigned to no leg and never runs. Measured
  // LOCALLY on 2026-09-19 against a production build on its own port and database
  // (`PORT=3187`), one test, three filings and three tree reads: **6.8 s** on a
  // freshly started server. Recorded as **8.0**, rounded UP, because
  // under-estimating is the direction that unbalances a bin-packer, and this
  // file's own calibration says a local reading runs at or below the CI cost.
  // Re-measure from the first green run that includes it.
  'planner-bug-destination.spec.ts': 8.0,
  'planning-anchor-level.spec.ts': 11.0,
  // Bug MOTIR-5782 · MOTIR-5796 — folders on the plan-review canvas: one test that
  // seeds the folder roadmap plus a two-proposal plan, arrives on a folder, crumbs
  // to the root and drills two folders deep. MEASURED locally on 2026-09-19 against
  // a PRODUCTION build (list reporter, the test's own time): **2.9 s**, warm — so
  // recorded as **5.0**, rounded UP because under-estimating is the direction that
  // unbalances a bin-packer. RE-MEASURE from the first green bulk artifact that
  // includes it, as for every new entry. (Its overlay twin,
  // `cloud-plan-change-folders.spec.ts`, runs on the cloud lane, which this plan
  // does not shard.)
  'plans-review-folders.spec.ts': 5.0,
  'plans-review.spec.ts': 14.8,
  // MOTIR-5539. Promoted from the acceptance lane (it was
  // `acceptance-pr-merge-mode.spec.ts`). ESTIMATED, not measured — it has never
  // run in this lane, and its acceptance-lane runtime is the receipt's `beat()`
  // pacing, which the promotion removed. One test: two sign-ins, three reloads or
  // navigations, three PATCHes and one routed failure — heavier than
  // `design-approval.spec.ts` (4.2), so recorded at 12.0 as a conservative
  // first-run cost. Re-measure from the first green `playwright-report-bulk-*`
  // artifact that includes it.
  'pr-merge-mode.spec.ts': 12.0,
  'profile.spec.ts': 11.4,
  // LOCAL provenance (MOTIR-6553): a brand-new spec, five tests, measured on
  // 2026-09-27 against a production build, JSON reporter, per-test durationMs
  // summed — 14.2 s (7.2 + 1.3 + 1.4 + 1.5 + 3.0). Rounded UP. Re-measure from
  // the first green CI run that includes it.
  'project-access-contractor.spec.ts': 15.0,
  'project-access.spec.ts': 9.7,
  'project-details.spec.ts': 7.7,
  'project-isolation.spec.ts': 5.4,
  'project-logo.spec.ts': 12.7,
  'project-repositories-api.spec.ts': 3.1,
  'projects-flow.spec.ts': 5.8,
  'provenance.spec.ts': 15.2,
  // Story MOTIR-3908 · Subtask MOTIR-4038 — the self-host arm of the
  // public-projects gate. ⚠️ AN ESTIMATE, not a measurement: one sign-up, three
  // navigations and eight API requests, no second browser session and no
  // seeding beyond a single project. Sized against `public-signin-modal`
  // (one sign-up plus one journey) with headroom, per the calibration note
  // above — under-estimating is the direction that unbalances the bin-packer.
  // RE-MEASURE from the first green CI run that includes it.
  'public-selfhost.spec.ts': 9.0,
  'quick-view-edit.spec.ts': 16.4,
  // MOTIR-6836 — ESTIMATED, not measured: three tests, a sign-up each; two seed
  // an eleven-item tree and walk the lanes, the third seeds 62 items over HTTP
  // and scrolls a pane until a second page streams in. Sized high, per the
  // calibration note above. RE-MEASURE from the first green CI run that has it.
  'ready-lanes.spec.ts': 45.0,
  'ready.spec.ts': 6.7,
  // ⚠️ `registration-lands-on-onboarding.spec.ts` (MOTIR-4876) carries the LOCAL
  // provenance, and the guard caught it with no entry on its FIRST CI run — the
  // failure this file exists to make loud, working exactly as designed. The spec
  // passed nothing, because a spec with no entry is assigned to no leg: it had
  // been silently skipped in every E2E lane since it was written.
  //
  // Measured on 2026-09-08 against a production build, on its own port (3987)
  // and its own database, JSON reporter, per-test `durationMs` summed, workers=1:
  // **30.4 s** on the first run (11.2 + 9.3 + 9.9) and **11.9 s** on the second.
  // The HIGHER reading is recorded, rounded up, following
  // `plan-decision-permission.spec.ts` and `plan-proposal-correction.spec.ts`
  // above — under-estimating is the direction that unbalances a bin-packer.
  //
  // The 2.5x spread is wider than any other local entry here and is worth the
  // warning: all three tests do a full browser sign-up, and each one resets the
  // database in a `beforeEach`, so the first run pays connection-pool and
  // Prisma-client warm-up that the second does not. Expect CI to land nearer the
  // warm reading than the cold one — RE-MEASURE from the first green CI run that
  // includes it, and expect this number to come DOWN.
  'registration-lands-on-onboarding.spec.ts': 31.0,
  'reports.spec.ts': 20.9,
  // ⚠️ A FOURTH provenance (MOTIR-3009): promoted out of the acceptance lane by
  // the story that changed the lifecycle it walks, and measured LOCALLY in this
  // lane on 2026-08-19 against a production build — it had never run here. The
  // number is small because `_helpers/promoted-regression` makes its ~10 pacing
  // beats no-ops; the SAME spec takes about a minute when it is recording. Like
  // the twelve above, re-measure it from the first green CI run that includes it.
  'repository-set.spec.ts': 4.7,
  'repository-reference.spec.ts': 18.0,
  'roadmap-auto-drill.spec.ts': 6.9,
  'roadmap-done-ready.spec.ts': 3.0,
  'roadmap-flow.spec.ts': 5.7,
  // Bug MOTIR-5710 · MOTIR-5743 — the folder journey on /roadmap: one test that
  // seeds a tenant with folders, drills two folders deep, crumbs back, reloads,
  // opens an empty folder and switches to sprint scope. MEASURED locally on
  // 2026-09-19 against the DEV server (JSON reporter, the test's `duration`):
  // **35.75 s**, first-hit route compilation included — an upper-side reading,
  // recorded as **36.0**, rounded UP because under-estimating is the direction
  // that unbalances a bin-packer. RE-MEASURE from the first green bulk artifact
  // that includes it, as for every new entry.
  'roadmap-folders.spec.ts': 36.0,
  'roadmap-fullscreen.spec.ts': 3.5,
  'roadmap-locate.spec.ts': 4.2,
  'roadmap-refresh-scope.spec.ts': 10.7,
  'roadmap-scope-toggle.spec.ts': 7.2,
  'roles-permissions.spec.ts': 15.9,
  'saved-filters.spec.ts': 17.0,
  // MOTIR-6855 — ESTIMATED, not measured: the UI sign-up this spec's beforeEach
  // runs fails in the sandbox it was written in (so did `not-found-theme`'s), so
  // no local reading exists. Two tests, each one sign-up + first project and one
  // or two navigations; priced from `not-found-theme.spec.ts`'s sign-up cost and
  // rounded UP. Replace with its measured CI time.
  'server-error-boundary.spec.ts': 10.0,
  'settings-area.spec.ts': 13.0,
  'shell-a11y-detail.spec.ts': 0,
  'shell-a11y-tokens.spec.ts': 0,
  'shell-a11y-wide.spec.ts': 0,
  'shell-a11y.spec.ts': 0,
  // MOTIR-7872 — measured LOCALLY against a production build on 2026-10-08:
  // 5.8 s for the one test body (sign-up, a style PATCH, two rail readings).
  // Recorded as 7.0 to cover its two `resetDatabase()` hooks (≈1.03 s each, the
  // `shell-viewport-floor` figure below), rounded UP. RE-MEASURE from CI.
  'shell-collapsed-rail-fit.spec.ts': 7.0,
  'shell-context-path.spec.ts': 14.1,
  'shell-empty-projects.spec.ts': 1.8,
  'shell-flows.spec.ts': 41.1,
  // ⚠️ AN ESTIMATE, not a measurement (MOTIR-4230) — this sandbox has no
  // Postgres, so the spec could not be run against a production build here. It
  // is one `signUp`, one `goto`, two appearance-radio clicks each awaited on a
  // PATCH 200 plus a committed `<html data-*>`, and three computed-style reads.
  // Sized against `appearance-sync.spec.ts` (7.0 — TWO sign-ups, four axis
  // changes and two raw server-document reads) and rounded UP, for this file's
  // standing reason: under-estimating is the direction that unbalances the
  // bin-packer. RE-MEASURE from the first green CI run that includes it.
  'shell-immersive-atmosphere.spec.ts': 5.0,
  'shell-keyboard.spec.ts': 0,
  'shell-viewport-floor.spec.ts': 11.4,
  'shell.spec.ts': 2.7,
  'scoped-run.spec.ts': 18.0,
  'sprint-delete.spec.ts': 7.2,
  'sprint-edit-dates.spec.ts': 6.5,
  'sprint-field.spec.ts': 7.5,
  'sprint-lifecycle.spec.ts': 8.8,
  'sprint-rename.spec.ts': 7.2,
  'status-derivation.spec.ts': 22.6,
  // ⚠️ LOCAL provenance, ESTIMATED rather than a full app run (MOTIR-3998) — this
  // sandbox has no Postgres, so the spec could not be run against a production
  // build here. What IS measured: the spec's dominant cost, the 44 computed-style
  // fingerprint reads (11 truth + 3 ancestors × 11 tiles), timed at ~123 ms in
  // headless Chromium against the real theme.css. The remainder — one public-page
  // `goto('/tokens')` plus 14 Style-control clicks each awaited on `<html
  // data-style>` — is estimated from the code path (no sign-in, no `resetDatabase`
  // hook, no network write) at ~2–3 s. Recorded as 5.0: the estimate rounded UP,
  // for this file's standing reason — under-estimating is the direction that
  // unbalances a bin-packer. Re-measure from the first green CI run that includes
  // it.
  'style-material-isolation.spec.ts': 5.0,
  'supervision-pool-under-load.spec.ts': 4.7,
  'token-permissions.spec.ts': 4.4,
  'triage-flow.spec.ts': 13.1,
  'passkeys.spec.ts': 7.7,
  'two-factor.spec.ts': 20.2,
  // ⚠️ MEASURED LOCALLY, not from a CI artifact (Story MOTIR-1215 · MOTIR-3650).
  // The file is new, so there is no green `main` run to read `result.duration`
  // out of yet. Summing the five tests' durations against a local prod build:
  // 35.9 s. That is the same quantity the table holds — Playwright attributes
  // hook time to the test it runs for — measured on a quieter box than a CI
  // runner, so treat it as a FLOOR and re-measure from the artifacts on the next
  // green run, exactly as this file's header prescribes.
  'two-factor-enforcement.spec.ts': 17.6,
  // MOTIR-6967 — MEASURED LOCALLY (1.5 s against a file:// page: no sign-up, no
  // seeding, no app route). Recorded at 3.0 as a floor-plus-margin; replace it
  // with its measured CI time.
  'design-render-mock-offline.spec.ts': 3.0,
  'work-item-delete.spec.ts': 6.8,
  'work-item-mentions.spec.ts': 6.5,
  'work-item-type-vocabulary.spec.ts': 6.9,
  'work-item-todo-list.spec.ts': 12.0,
  'work-item-type.spec.ts': 7.8,
  'work-items-isolation.spec.ts': 17.6,
  'workflow-delete-reassign.spec.ts': 10.0,
  'workflow-flow.spec.ts': 6.0,
  'workflow-settings.spec.ts': 6.4,
  'workspace-flows.spec.ts': 7.5,
  // MOTIR-6465 — ESTIMATED from `workspace-flows.spec.ts` (one sign-up, one
  // settings render, the same shape); replace with its measured CI time.
  'workspace-members-roles.spec.ts': 7.5,
};

/**
 * Bin-pack specs across the legs by measured cost — longest-processing-time
 * first: walk the specs from most to least expensive and hand each to the leg
 * with the least load so far.
 *
 * Deterministic by construction: the sort tie-breaks on the file name and the
 * leg choice tie-breaks on matrix order, so the same costs always yield the same
 * assignment. That matters because the Playwright config and the CI matrix
 * compute it independently on every leg — a non-deterministic assignment would
 * silently drop or double-run specs.
 */
export function assignBulkLegs(
  costs: Readonly<Record<string, number>> = SPEC_COST_SECONDS,
  legIds: readonly string[] = BULK_LEG_IDS,
): Record<string, string[]> {
  const assignment: Record<string, string[]> = {};
  const load: number[] = [];
  for (const id of legIds) {
    assignment[id] = [];
    load.push(0);
  }
  const ordered = Object.keys(costs).sort((a, b) => {
    const delta = (costs[b] ?? 0) - (costs[a] ?? 0);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  for (const spec of ordered) {
    let pick = 0;
    for (let i = 1; i < legIds.length; i++) {
      if ((load[i] ?? 0) < (load[pick] ?? 0)) pick = i;
    }
    assignment[legIds[pick] as string]?.push(spec);
    load[pick] = (load[pick] ?? 0) + (costs[spec] ?? 0);
  }
  return assignment;
}

/** The spec files assigned to `legId`, or `null` when it is not a bulk leg. */
export function specsForLeg(legId: string): string[] | null {
  return assignBulkLegs()[legId] ?? null;
}

/** The total measured cost of a leg, in seconds. */
export function legCostSeconds(legId: string): number {
  return (specsForLeg(legId) ?? []).reduce((sum, s) => sum + (SPEC_COST_SECONDS[s] ?? 0), 0);
}

/**
 * A `testMatch` RegExp selecting exactly this leg's spec files — an anchored
 * alternation over the file names rather than a glob, so a name containing a
 * glob metacharacter (or a future nested spec directory) can never widen the
 * selection. Returns `null` for a leg id that is not a bulk leg, which is how
 * the Playwright config leaves the a11y / at-scale / billing lanes untouched.
 */
export function legTestMatch(legId: string): RegExp | null {
  const specs = specsForLeg(legId);
  if (!specs) return null;
  const alternation = specs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`[\\\\/]tests[\\\\/]e2e[\\\\/](?:${alternation})$`);
}
