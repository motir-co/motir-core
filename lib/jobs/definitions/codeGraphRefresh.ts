import { defineJob } from '../defineJob';
import { runIndexHandoffSteps } from '../indexHandoffSteps';
import type { CodeGraphRefreshData } from '../types';

// Code-graph REFRESH job (Story 7.10 · MOTIR-893, the completing feed slice;
// moved onto the INDEX FLEET by MOTIR-2057, handed off to motir-ai by MOTIR-11883)
// — a default-branch PUSH to a connected repo, a planning session that starts on a
// stale graph, the catch-up sweep or a manual refresh re-indexes that repo.
// Enqueued best-effort (`enqueueCodeGraphRefresh`) AFTER the trigger resolves to a
// stored repo, so a webhook returns 2xx fast and the index never runs inline in
// the delivery.
//
// ⚠️ IT HANDS THE WORK OFF, LIKE THE FIRST INDEX (MOTIR-11883) — the SAME step
// shape, `runIndexHandoffSteps`: the live default-branch head and a pre-signed
// source URL minted AT it go to motir-ai, which starts motir-codegraph's job, and
// the run polls motir-ai's status route until that commit settles. A run whose
// payload says `refreshCause: 'push'` — the GitHub and GitLab push webhooks, and
// only they — compares the head motir-core last stamped with the live one and hands
// off a `push` with the host's changed paths (MOTIR-11884); every other run, and a
// push whose comparison cannot be vouched for, is a `refresh`.
//
// ⚠️ THERE IS NO DEBOUNCE ANY MORE (MOTIR-11884), and DO NOT ADD ONE BACK. It
// existed so a burst of pushes built ONE graph on a container each run paid for.
// The service's own queue now supersedes a still-queued push of the same repository
// and ref by a newer one (motir-codegraph `docs/api-contract.md`, the indexing
// calls), so coalescing here would only delay the newest push by the window: every
// event is due the moment it is enqueued, and each run hands off. A run whose handed
// commit the service superseded or overtook settles on the newer PUBLISHED head
// (`settledOutcome`'s superseded arm) instead of waiting out its deadline for a
// commit that is never published. Comparing the STAMPED head with the live head
// covers every push since the last published index, however many runs race, so no
// run needs an earlier push's payload.
//
// SYSTEM-scoped (enqueued via `sendSystemEvent`, not `sendEvent`) and
// `retryPolicy: 'idempotent'` for the reason the index job carries it: a
// re-handed commit rebuilds the same graph over the same commit, so a transient
// blip is worth the `idempotent` policy's full 5-attempt budget — and the handoff
// sits inside a memoized step, so a retry resumes polling rather than handing off
// again.
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
//      This loop waited with `ctx.step.sleep` (the deleted `indexFleetSteps.ts`,
//      `index-wait:<pid>:<n>`), so between polls it held NOTHING. A
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
// The cap lived where the containers were — `codeGraphIndexAdmissionService`,
// deleted with the indexer fleet (MOTIR-12036). The build now runs in
// motir-codegraph, which owns its own capacity.
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
  },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphRefreshData;
    return runIndexHandoffSteps(
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
      { refreshCause: data.refreshCause },
    );
  },
);
