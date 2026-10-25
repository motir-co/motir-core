import { defineJob } from '../defineJob';
import { runIndexFleetSteps } from '../indexFleetSteps';
import type { CodeGraphRefreshData } from '../types';

// Code-graph REFRESH job (Story 7.10 · MOTIR-893, the completing feed slice;
// moved onto the INDEX FLEET by MOTIR-2057) — a default-branch PUSH to a
// connected repo rebuilds that repo's graph for every project of its workspace.
// Enqueued best-effort by the webhook's `push` handler
// (`enqueueCodeGraphRefresh`, GitHub and GitLab alike) AFTER the push resolves
// to a stored repo, so the webhook returns 2xx fast and the re-index never runs
// inline in the delivery.
//
// ⚠️ IT RUNS ON THE FLEET, LIKE THE FIRST INDEX — the SAME step shape,
// `runIndexFleetSteps`, not a copy of it. THE BYTES ARE GONE FROM THIS PROCESS:
// dispatch resolves a pre-signed tarball URL and boots ONE CONTAINER per
// (repo × project) which fetches and builds the graph itself
// (`docs/decisions/code-graph-index-fleet.md` §2, §11).
//
// WHY IT MOVED (MOTIR-2057). MOTIR-1981 moved `system.code-graph-index` onto the
// fleet and left this job — architecturally the same work — on the
// serverless→HTTP path it was retiring: fetch the whole tarball into the Vercel
// function, POST the bytes to motir-ai, all under a 180 s client deadline (the
// upload client that carried it is itself deleted — MOTIR-2138). `motir-core`'s own whole-tree
// parse does not fit in 180 s, so its refresh failed DETERMINISTICALLY, and its
// five idempotent retries then queued against motir-ai's single 1-permit parse
// gate and starved every other repo's refresh — a ~68% failure rate for three
// straight days (Aug 2 7/18, Aug 3 7/16, Aug 4 8/17), which is why the symptom
// read as "intermittent motir-ai unavailability" rather than as one repo's
// deterministic timeout. On the container path no wall clock bounds the parse,
// because a STEP — never a run — is the unit the platform's timeout applies to
// (`docs/jobs.md` rule 1).
//
// ⚠️ A REFRESH HAS ALWAYS BEEN A FULL REBUILD; the fleet does not change that,
// and the claim that it was incremental was in THIS comment. motir-ai's
// incremental entry is `GraphIndexPublisher.refresh` (an engine diff, optionally
// over `changedPaths`) and NO caller has ever reached it: the bytes route this
// job used to POST to (`POST /v1/code-graph/index`) runs `receiveAndIndex` →
// `indexAndPublish` → `store.indexRepo`, a whole-tree build — exactly what the
// container does. So moving to the fleet loses no incremental semantics; it
// moves the same whole-tree parse off a 180 s budget onto a container with a
// 30-minute one. What it DOES change is where the cost lands: a metered fleet
// container per (repo × project) per debounced push, admitted by
// `codeGraphIndexAdmissionService`, instead of a queue behind one parse permit.
//
// DEBOUNCED per repo, and THAT is now the whole difference between this job and
// `system.code-graph-index`: rapid pushes to the same repo coalesce — Inngest
// holds the run until `period` passes with no further same-key event, then runs
// ONCE with the latest event. The run indexes the repo AT ITS DEFAULT BRANCH
// (not a pinned SHA), so the one coalesced run builds the newest head — exactly
// the semantics a debounce wants. The initial index must run promptly on install
// and so must never sit out a debounce window, which is why the two stay separate
// events rather than becoming one job with a flag.
//
// ⚠️ THE COALESCING IS MEASURED, THE `timeout` CAP IS NOT WHAT THIS COMMENT USED
// TO CLAIM (MOTIR-2994). Coalescing was asserted here only at the config level —
// which passes whatever the executor does — until it was driven against the real
// scheduler: a same-key burst does produce exactly ONE run carrying the latest
// event, and distinct repos stay independent, so the fleet cost model in
// `docs/decisions/code-graph-index-fleet.md` §7.3/§7.4 holds. But this comment
// also said `timeout` "caps the total deferral so a steady push stream still
// refreshes at least every 15m", and on the dev server that is FALSE for a stream
// faster than ~1 event/second — the cap never fires and the run lands only once
// the stream stops. **This job is not exposed**: its producer is default-branch
// pushes to one repo, which do not arrive at that rate. The debounce is KEPT
// unchanged and the limit recorded; see `docs/jobs.md` § Debounce for the table.
//
// ⚠️ ONE EMITTER DOES NOT WAIT OUT THE PERIOD (MOTIR-5360). A planning session
// that starts on a stale graph enqueues with `trigger: 'session_start'`
// (`enqueueCodeGraphRefresh`), which makes its arrival due NOW. It is the SAME
// event under the SAME key, so it coalesces into a refresh already queued for the
// repo and pulls it forward; it never queues a second one beside it. Pushes are
// unchanged: they still wait out `period`, and the declaration below is still
// the default for every emitter that says nothing. The per-arrival switch lives
// on the dispatch rather than here because the period is right for one trigger
// and wrong for the other, and a job declares one debounce.
//
// ⚠️ AND THE KEY BELOW MUST KEEP NAMING ONLY REQUIRED FIELDS. A `key` expression
// that does not resolve merges every such event into ONE debounce bucket instead
// of skipping the debounce, so making any of `installationId` / `repoOwner` /
// `repoName` optional on `CodeGraphRefreshData` would silently coalesce unrelated
// repos. `tests/jobs/debounce-burst.test.ts` pins that.
//
// SYSTEM-scoped (enqueued via `sendSystemEvent`, not `sendEvent`) and
// `retryPolicy: 'idempotent'` for the reason the index job carries it: a
// re-dispatched container rebuilds the same graph over the same commit-derived
// key, so a transient blip is worth the `idempotent` policy's full 5-attempt budget — and every
// phase sits inside a memoized step, so a retry RESUMES at the project that
// failed instead of re-booting the containers that already succeeded.
//
// ⚠️ THERE IS DELIBERATELY NO `concurrency` HERE ANY MORE (MOTIR-2057), and DO
// NOT ADD ONE BACK. It carried `concurrency: 2` for a scale-to-zero motir-ai
// whose cold start each parallel run paid — the same number, and the same
// reason, MOTIR-1990 removed from the index job. All three of that job's
// arguments now apply here verbatim, because this one supervises containers too:
//
//   1. IT WOULD MAKE THE CONFIGURED CAP A LIE. A stepped supervision loop stays
//      RESIDENT for the CONTAINER'S WHOLE LIFE, where the old shape ran for one
//      fetch-and-upload. `2` beside a configured cap of six would mean two,
//      always, whatever an operator set.
//
//      ⚠️ CORRECTED (MOTIR-3245) — this used to say the loop holds its INNGEST
//      CONCURRENCY SLOT for the container's whole life, and MOTIR-3245 was filed
//      on that sentence. It is false. Inngest's concurrency documentation is
//      explicit: *"A function run that is sleeping, waiting for an event, or
//      paused between steps does not count against your concurrency limit. Only
//      steps that are actively executing code count toward the limit"*, and
//      *"calling `step.sleep`, `step.sleepUntil`, `step.waitForEvent`, or
//      `step.invoke` does not count towards capacity limits."*
//
//      This loop waits with `ctx.step.sleep` (`indexFleetSteps.ts`,
//      `index-wait:<pid>:<n>`), so between polls it holds NOTHING. A
//      `concurrency: N` here would bound N concurrent POLLS, not N live
//      containers — so the conclusion below is unchanged and its reason is now
//      the true one rather than a plausible one.
//
//      ⚠️ AND IT IS NOW MEASURED, NOT ONLY CITED (MOTIR-3246). The doc quote
//      above was the whole warrant, and the disagreement this correction settles
//      was between two COMMENTS — so a third citation would not have settled it.
//      At `concurrency: { limit: 1 }`, three runs sleeping 8 s all entered
//      within 294 ms and finished within 8.6 s; the CONTROL arm, three runs
//      holding the same 8 s inside a `step.run`, serialized 8 s apart and
//      finished at 24 s (`scripts/experiments/inngest-sleep-concurrency.mjs`,
//      two trials each, `inngest-cli` 1.27.0). The control is what makes it
//      decisive: without it a prompt start would equally mean the limit never
//      applied. Production runs Inngest CLOUD, which this harness cannot drive —
//      `docs/decisions/job-lane-occupancy.md` §1 states that limit, §2 the ~128
//      sub-second steps a 30-minute index actually occupies, and §4 which of
//      MOTIR-3245's proposed fixes the answer rules out.
//   2. AN UNKEYED LIMIT IS THE STARVATION IT WAS MEANT TO PREVENT — and THIS job
//      is where that was measured: one repo's retries ahead of every other
//      repo's refresh is the production failure MOTIR-2057 fixed. A per-tenant
//      limit here would need a KEYED concurrency. `defineJob` CAN express one
//      since MOTIR-1982 — but reason 1 rules it out here anyway: a cap on a
//      container supervisor caps SUPERVISORS, not containers, keyed or not.
//   3. ITS ORIGINAL REASON IS GONE. The bytes moved to the containers; what
//      remains in-process is one short credential mint.
//
// The cap lives where the containers are — `codeGraphIndexAdmissionService`, a
// global bound read from `MOTIR_INDEX_MAX_IN_FLIGHT` plus a per-workspace bound
// of `ceil(global / 2)` — which is also the only place that can see the OTHER
// workloads sharing the invoice (MOTIR-1997).
//
// ⚠️ AND WHAT PROTECTS EVERY OTHER FUNCTION, since the absence of a cap here is
// exactly the thing that used to look alarming (MOTIR-3247). The reasoning above
// says why a cap on THIS job would be meaningless; it stopped short of saying
// what the interactive jobs may therefore rely on, and MOTIR-3245 was filed in
// that gap. The answer is now measured rather than argued:
//
//   1. THIS JOB IS NOT WHAT DELAYS THEM. A supervisor holds a slot only while a
//      `step.run` executes — ~128 sub-second steps across a 30-minute index,
//      released between every one — so the worst a queued run waits behind one
//      is ONE POLL, not one container's life
//      (`docs/decisions/job-lane-occupancy.md` §1–§2).
//   2. THE CORRELATION WAS CHECKED IN BOTH DIRECTIONS AND IS NOISE. Splitting
//      production `work-item/transitioned` latency on whether a refresh was
//      running gives OPPOSITE answers on a 24 h and a 72 h window (§6). Neither
//      "a refresh slows the fast lane" nor its inverse survives re-measurement.
//   3. THE FAST LANE HAS A STATED BUDGET AND A GUARD. `lib/jobs/latencyBudget.ts`
//      carries the number and its measured baseline;
//      `tests/jobs/fast-lane-latency-budget.test.ts` pins the lane's membership
//      and asserts that no consumer of it is capped or debounced. So "nothing
//      caps this job" is a decision with a check behind it rather than an
//      omission — and if a cap is ever wanted here, that record is what has to
//      change first.
//
// What is NOT claimed: that the budget is currently MET. It is not — measured
// p95 is ~20-29 s against a 5 s target, and §6 attributes the gap to arrival
// burstiness rather than to anything on this job's side.
export const codeGraphRefresh = defineJob(
  {
    id: 'system.code-graph-refresh',
    retryPolicy: 'idempotent',
    debounce: {
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    },
  },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphRefreshData;
    return runIndexFleetSteps(
      ctx,
      services,
      {
        installationId: data.installationId,
        // The repo's own tenant, stamped at enqueue from `repo.workspaceId`
        // (MOTIR-1931) — never re-derived from the shared installation.
        workspaceId: data.workspaceId,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        defaultBranch: data.defaultBranch,
      },
      'system.code-graph-refresh',
    );
  },
);
