import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import type { EngineJobDefinition } from '@/lib/jobs/defineJob';
import { registerEngineJob } from '@/lib/jobs/engine/registry';
import { runIndexFleetSteps } from '@/lib/jobs/indexFleetSteps';
import type { CodeGraphIndexData, CodeGraphRefreshData } from '@/lib/jobs/types';

// THE CONTAINER PATH, AS THE TWO JOBS DROVE IT BEFORE MOTIR-11883.
//
// Since MOTIR-11883 `system.code-graph-index` and `system.code-graph-refresh` hand
// the index off to motir-ai (`runIndexHandoffSteps`). The container path —
// `runIndexFleetSteps`, admission, dispatch, supervision — stays in the tree,
// unreached, until its own deletion, and the suites that pin ITS behaviour keep
// running against it through these two definitions: the REAL jobs' options (id,
// retry policy, debounce) spread unchanged, with the handler each job had before.
//
// Not registered with the engine by default: a test hands one to `JobTestEngine`
// directly, so the real definitions stay the only ones the registry holds. A suite
// that drives the REAL worker over the registry (`executeWithLedger`) swaps them in
// for its own duration with `registerFleetIndexJobs` / `restoreHandoffIndexJobs`,
// in `beforeAll` / `afterAll` — the registry is module state shared by every file a
// worker runs, so a suite that swaps without restoring would hand the next file the
// container path. Delete this file with `runIndexFleetSteps`.

/** `system.code-graph-index` as it was: the fleet, then the first-audit step. */
export const fleetCodeGraphIndex: EngineJobDefinition = {
  ...codeGraphIndex,
  handler: async (ctx, services) => {
    const data = ctx.event.data as CodeGraphIndexData;
    const result = await runIndexFleetSteps(
      ctx,
      services,
      {
        installationId: data.installationId,
        workspaceId: data.workspaceId,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        defaultBranch: data.defaultBranch,
      },
      'system.code-graph-index',
    );
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
};

/** `system.code-graph-refresh` as it was: the fleet. */
export const fleetCodeGraphRefresh: EngineJobDefinition = {
  ...codeGraphRefresh,
  handler: (ctx, services) => {
    const data = ctx.event.data as CodeGraphRefreshData;
    return runIndexFleetSteps(
      ctx,
      services,
      {
        installationId: data.installationId,
        workspaceId: data.workspaceId,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        defaultBranch: data.defaultBranch,
      },
      'system.code-graph-refresh',
    );
  },
};

/** Register the two container-path copies under the shipped ids. Pair with `restoreHandoffIndexJobs`. */
export function registerFleetIndexJobs(): void {
  registerEngineJob(fleetCodeGraphIndex);
  registerEngineJob(fleetCodeGraphRefresh);
}

/** Put the shipped (handoff) definitions back in the registry. */
export function restoreHandoffIndexJobs(): void {
  registerEngineJob(codeGraphIndex);
  registerEngineJob(codeGraphRefresh);
}
