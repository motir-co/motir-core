import { defineJob } from '../defineJob';
import { runIndexFleetSteps } from '../indexFleetSteps';
import type { CodeGraphIndexData } from '../types';

// Code-graph INDEX job (Story 7.5 · MOTIR-1500, re-shaped by Story MOTIR-1981 ·
// MOTIR-2027) — index a newly-added repo's source into every project of its
// workspace. Enqueued best-effort AFTER the installation's repos persist
// (`enqueueCodeGraphIndex`), so the webhook returns fast and a failed
// GitHub/motir-ai call can never roll back or block the grant mirror (the
// side-effects-outside-tx rule).
//
// ⚠️ THE BYTES ARE GONE FROM THIS PROCESS. It used to fetch the repo's tarball
// into the function's heap and upload it to motir-ai once per project; since
// MOTIR-2027 it resolves a pre-signed URL and dispatches ONE CONTAINER per
// (repo × project) that fetches and builds the graph itself
// (`docs/decisions/code-graph-index-fleet.md` §2). The step shape that drives
// it is `runIndexFleetSteps` — read the note there for why supervision is a
// sequence of bounded steps and not a loop.
//
// SYSTEM-scoped (`system.*`): the work spans an installation's workspace + its
// projects, resolved under `withSystemContext` inside the service — like every
// `system.*` job, it is enqueued via `sendSystemEvent` (NOT `sendEvent`, whose
// workspace-scoping invariant a system payload cannot satisfy).
//
// `retryPolicy: 'idempotent'`: re-indexing the same repo is convergent by
// construction (a re-dispatched container rebuilds the same graph and overwrites
// the same commit-derived key), so a transient blip is worth the policy's full
// 5-attempt budget — and because every phase now sits inside a memoized step, a
// retry RESUMES at the project that failed instead of re-booting the containers
// that already succeeded. All the work is delegated to services (the 4-layer
// "handler is a service caller" rule — the `billingSeatSync` precedent).
//
// ⚠️ THERE IS DELIBERATELY NO `concurrency` HERE ANY MORE (MOTIR-1990,
// `docs/decisions/code-graph-index-fleet.md` §7). The cap lives in the
// ORCHESTRATOR's admission control — `codeGraphIndexAdmissionService`, a global
// bound read from `MOTIR_INDEX_MAX_IN_FLIGHT` plus a per-workspace bound of
// `ceil(global / 2)` — and DO NOT ADD ONE BACK. Three reasons, in order of how
// badly each bites:
//
//   1. IT WOULD MAKE THE CONFIGURED CAP A LIE. A stepped supervision loop stays
//      RESIDENT for the CONTAINER'S WHOLE LIFE, where the old shape ran for one
//      fetch-and-upload. `concurrency: 2` beside a configured cap of six would
//      mean two, always, whatever an operator set.
//
//      ⚠️ CORRECTED (MOTIR-3246) — this used to say the loop holds its INNGEST
//      CONCURRENCY SLOT for the container's whole life. It does not, and this
//      file is where that sentence was FIRST written (MOTIR-1990); the sibling
//      supervisor's copy of it was corrected by MOTIR-3245 while this one was
//      missed, which is how it would have been re-derived from its origin.
//      A run inside `ctx.step.sleep` occupies NOTHING: measured on the shipped
//      scheduler at `concurrency: { limit: 1 }`, three sleeping runs all entered
//      within 294 ms and all finished within 8.6 s, where the same three holding
//      the slot in a `step.run` serialized 8 s apart and finished at 24 s
//      (`scripts/experiments/inngest-sleep-concurrency.mjs`; two trials each).
//      So the loop holds a slot for ~128 sub-second `step.run`s spread over a
//      30-minute index and releases it between every one — not for 30 minutes.
//      `docs/decisions/job-lane-occupancy.md` §1–§2 carries the method and the
//      arithmetic. The CONCLUSION below is unchanged: a cap here would bound
//      concurrent POLLS, a quantity with no relationship to containers in
//      flight.
//   2. AN UNKEYED LIMIT IS THE STARVATION IT WAS MEANT TO PREVENT. It is global
//      and tenant-blind, so one workspace's five repos occupy the lane while
//      another workspace's first index queues behind all of it — the measured
//      behaviour §7 records. A per-tenant limit HERE would need a KEYED
//      concurrency. `defineJob` CAN express one since MOTIR-1982 — but that
//      does not make it right here, because reason 1 still applies to a keyed
//      limit exactly as it does to an unkeyed one: any Inngest-level cap on a
//      job that supervises containers caps SUPERVISORS, not containers.
//   3. ITS ORIGINAL REASON IS GONE. `2` existed for a scale-to-zero motir-ai
//      whose cold start took 23.3s on 2026-08-02, when five runs each fetched a
//      tarball and uploaded it from this process. The bytes moved to the
//      containers (§2); what remains in-process is one short credential mint.
//      The admission cap bounds the herd far more precisely than a run count did.
//
// The cap is now enforced where the containers actually are, which is also the
// only place that can see the OTHER workloads sharing the invoice (MOTIR-1997).
//
// NOTE: this is motir-core's OWN internal job substrate. It is unrelated to
// motir-ai's frozen JOB_KINDS contract — motir-ai exposes a plain bytes route
// (`POST /v1/code-graph/index`), NOT a JobKind, so `lib/ai/types.ts` is untouched.
//
// ⚠️ SUCCESS NOW EMITS SOMETHING, AND IT IS THE ONE THING THIS FILE ADDS BEYOND
// THE FLEET STEPS (MOTIR-2266 · `docs/decisions/audit-on-first-index.md`). A repo
// used to get a code graph automatically and an assessment never; the trailing
// `derive-first-audit` step closes that, firing the repo's `code_audit` +
// `propose_convention` pair when — and only when — it has no derived audit yet.
//
// IT LIVES HERE AND NOT IN `runIndexFleetSteps` ON PURPOSE. That function is
// shared with `system.code-graph-refresh` (MOTIR-2057), and the record decides
// the FIRST audit only: whether an audit should refresh when a repo is re-indexed
// after new commits is a separate, recurring-spend question §4 deliberately
// leaves open. Putting the step in the shared shape would answer it by accident.
// The step-shape PARITY test between the two jobs knows about this one
// divergence by name.
export const codeGraphIndex = defineJob(
  { id: 'system.code-graph-index', retryPolicy: 'idempotent' },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphIndexData;
    const result = await runIndexFleetSteps(
      ctx,
      services,
      {
        installationId: data.installationId,
        // Carried on the payload since MOTIR-1500 and now LOAD-BEARING
        // (MOTIR-1931): it is the repo's own tenant, stamped at enqueue.
        workspaceId: data.workspaceId,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        defaultBranch: data.defaultBranch,
      },
      'system.code-graph-index',
    );

    // ⚠️ GATED ON `indexed`, SO A NO-OP RUN'S STEP SHAPE IS UNCHANGED. The three
    // vanished-tenant verdicts and `provider_cannot_index` return `indexed: false`
    // WITHOUT throwing (they are the ledger's contract), and none of them put a
    // graph anywhere — there is nothing to assess. A FAILED index never reaches
    // this line at all: `runIndexFleetSteps` throws.
    //
    // Its OWN step, so the derivation is checkpointed exactly once per run and a
    // replay reads the memo rather than re-submitting. `deriveFirstAudit` never
    // throws (see its contract), which is what keeps a motir-ai blip from failing
    // — and Inngest from retrying — a run whose index already succeeded.
    if (result.indexed) {
      await ctx.step.run('derive-first-audit', () =>
        services.firstAuditTrigger.deriveFirstAudit({
          workspaceId: data.workspaceId,
          repoRef: result.repoRef,
        }),
      );
    }

    return result;
  },
);
