import type { MigrateIndexRepoDto, MigrateIndexStatusDto } from '@/lib/dto/migrateOnboarding';
import type { ProjectPlanningGateDto, ProjectStateDto } from '@/lib/dto/projectState';
import { toMigrateOnboardingDto } from '@/lib/mappers/migrateOnboardingMappers';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { toOrgContentLanguage } from '@/lib/workItems/contentLanguage';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { deriveMigrateIndexRepoState } from '@/lib/codeGraph/migrateIndexRepoState';
import { deriveRefreshFailing } from '@/lib/codeGraph/refreshReason';

// The project's PLANNING PRECONDITIONS, in ONE read (MOTIR-1968) — an ADAPTER
// over four shipped reads, not a new capability.
//
// WHY it exists: an agent planning over the MCP could not check a single thing
// about the tenant it was planning FOR. MOTIR-1755 was authored twice on
// unverified tenant state — "the repos were never connected" (they had been, for
// months) and then "the code graph is driven by the grant" (zero of five repos
// had a graph, and no shipped path could ever give them one) — and neither claim
// was checkable over the surface. The second cost a whole card of manual audit
// and produced MOTIR-1961 + MOTIR-1963. This service is the read that turns both
// assertions into questions.
//
// SCOPE: read-only, and everything it reads is a `motir-core` table. There is no
// write here — no way to stamp the marker, trigger an index, or advance a
// migrate run — and no `motir-ai` round-trip, which is what keeps this one repo.
// Pre-plan document contents and the code-graph query surface stay behind the
// open-core boundary; the planner already reaches those through the job envelope.
//
// COMPOSITION, deliberately: every answer is the SHIPPED one.
//   * established?      → the project's own `onboardingRanAt` marker. It read
//                          `resolvePlanningHostGate` until MOTIR-4765 took the
//                          `onboarding` verdict off that gate; see the call site
//   * code connected?   → `githubInstallationService.listOrganizationInstallations`
//                          (MOTIR-4836) — the ORGANISATION's connections and the
//                          repositories they grant, which is the tier a
//                          connection has been owned at since MOTIR-4669
//   * code indexed?     → the succeeded-index ledger, projected into the wizard's
//                          `MigrateIndexStatusDto`
//   * project's repos?  → `projectRepoSetService.listByProject` (MOTIR-1780)
//   * onboarding state? → the project's `MigrateOnboarding` run, or null
//
// COST: constant in the number of repos. The index state comes from ONE ledger
// query (`listSucceededCodeGraphIndexRepoRefs` → a Set) rather than the per-repo
// `findSucceededCodeGraphIndex` the wizard's poll issues — an N+1 the wizard can
// afford at its single-digit repo count and an MCP read should not inherit.

/**
 * The CONNECTED half: is a git host connected to this tenant, which repositories
 * did it bring, and are they indexed?
 *
 * ⚠️ THE ORGANISATION'S, NOT THE WORKSPACE'S (MOTIR-4838). This read used to do
 * a two-step hop — `githubInstallationRepository.findByWorkspaceId(ctx.workspaceId)`
 * and the repositories hanging off it — and `findByWorkspaceId` compares
 * `workspace_id` IN THE SQL. A connection (and the repositories it grants) is
 * owned by the ORGANISATION as of MOTIR-4669, and the App is installed from ONE
 * of its workspaces, so from every OTHER workspace the first line answered null,
 * the second never ran, and this reported `installed: false` with an empty
 * index. `get_project_state` exists so a planning agent can VERIFY a tenant
 * precondition instead of asserting one (MOTIR-1968) — a confident, wrong `no`
 * from it is worse than no read at all, because the first thing it costs is the
 * caller's reason to check.
 *
 * ⚠️ IT IS THE TIER THAT MOVED, NOT THE QUESTION — and that boundary is what
 * keeps the fix from being a different wrong answer. This half stays the
 * CONNECTED registry, deliberately distinct from `repoSet`, which is the
 * PROJECT's own repositories and is read separately below. Re-pointing this at
 * `projectRepoSetService` would collapse the two into one and delete a
 * distinction the DTO documents and the suite pins twice: an installation whose
 * grant covers no repositories is a DIFFERENT state from no installation, and a
 * project's set is a different question from what its tenant has connected.
 *
 * ⚠️ `findByWorkspaceId` IS NOT THE DEFECT AND IS UNTOUCHED. It is honestly
 * named and correct for a workspace's OWN grant; what was wrong is which
 * surfaces asked it.
 *
 * ⚠️ THE INDEX LEDGER IS STILL WORKSPACE-KEYED, on purpose. `job_run` rows are
 * written in the workspace that ran the index, so a repository indexed from a
 * SIBLING workspace reads `pending` here — honestly, since this workspace has no
 * record of it. Re-tiering the code graph to the organisation is Story
 * MOTIR-4642's whole subject and needs a policy arm of its own; this card fixes
 * the two installation hops its sweep named and does not reach past them.
 */
async function resolveCodeState(
  ctx: ServiceContext,
): Promise<{ installed: boolean; index: MigrateIndexStatusDto }> {
  // The organisation's connections, with the repositories each grants. The read
  // opens its own transaction because it binds an organisation GUC the ledger
  // reads below neither need nor should see.
  const installations = await githubInstallationService.listOrganizationInstallations({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const repos = installations.flatMap((installation) =>
    installation.repos.map((repo) => ({ provider: installation.provider, repo })),
  );

  // ONE workspace-scoped transaction for the LEDGER reads, so the job_run RLS
  // policy sees the bound workspace GUC and the halves are consistent.
  const { indexedRefs, running, runningRunIds, terminalRunIds, organizationId } =
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      // The whole ledger for this workspace in one query — the N+1 the per-repo
      // lookup would be. `output.repoRef` is `owner/name`, the same spelling
      // `resolveCodeContext` builds, so the Set membership test is exact.
      const refs = new Set(
        await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx),
      );
      const run = await jobRunRepository.findRunningCodeGraphIndexForWorkspace(ctx.workspaceId, tx);
      return {
        indexedRefs: refs,
        running: run,
        runningRunIds: new Set(
          await jobRunRepository.listRunningCodeGraphRunIds(ctx.workspaceId, tx),
        ),
        terminalRunIds: new Set(
          await jobRunRepository.listTerminalCodeGraphRunIds(ctx.workspaceId, tx),
        ),
        organizationId: await resolveOrganizationId(ctx.workspaceId, tx),
      };
    });

  // Each repository's index POINTER and size refusal — the facts the wizard's
  // four-state derivation reads (MOTIR-8768), so this read and the wizard's poll
  // name the same state for the same repository. Skipped when nothing is
  // connected.
  const pointers = new Map(
    repos.length === 0
      ? []
      : (
          await githubInstallationService.listOrganizationRepoIndexPointers({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            organizationId,
          })
        ).map((row) => [row.repoRef, row] as const),
  );

  const rows: MigrateIndexRepoDto[] = repos.map(({ provider, repo }) => {
    const repoRef = `${repo.owner}/${repo.name}`;
    const pointer = pointers.get(repoRef);
    const indexingRunId = pointer?.indexingRunId ?? null;
    return {
      provider,
      repoRef,
      // `queued` still covers "nothing ever tried" — MOTIR-1961's repos sat there
      // forever — beside "enqueued, not yet claimed".
      status: deriveMigrateIndexRepoState({
        hasSucceededIndex: indexedRefs.has(repoRef),
        hasRunningIndex: indexingRunId !== null && runningRunIds.has(indexingRunId),
        refreshFailing: deriveRefreshFailing({ indexingRunId, terminalRunIds }),
        refusedForSize: (pointer?.indexRefusedAt ?? null) !== null,
      }),
    };
  });
  const indexedCount = rows.filter((row) => row.status === 'indexed').length;
  const total = rows.length;

  return {
    installed: installations.length > 0,
    index: {
      repos: rows,
      indexedCount,
      failedCount: rows.filter((row) => row.status === 'failed').length,
      total,
      hasRunning: running !== null,
      // `total > 0` deliberately: "every one of zero repos is indexed" is a
      // true statement and a useless one. Matches the wizard's Next gate.
      allIndexed: total > 0 && indexedCount === total,
    },
  };
}

export const projectStateService = {
  /**
   * A project's planning preconditions — established?, code connected + indexed?,
   * repository set, where onboarding stopped — resolved by project KEY.
   *
   * TENANCY is structural, not checked here: `projectsService.getByKey` resolves
   * the key INSIDE the token-bound workspace and browse-gates the result, so a
   * key belonging to another tenant reads as `ProjectNotFoundError` — the same
   * 404-not-403 answer an unknown key gets, with no existence leak. `projectKey`
   * is therefore not a way around the binding: it selects within it.
   *
   * Every downstream read is scoped by the SAME `ctx`, so no branch of this
   * answer can come from a workspace the caller is not in.
   */
  async getProjectState(projectKey: string, ctx: ServiceContext): Promise<ProjectStateDto> {
    const project = await projectsService.getByKey(projectKey, ctx);

    // ⚠️ READ OFF THE MARKER, NOT OFF `resolvePlanningHostGate` (MOTIR-4765).
    // This line used to call the host gate, because the gate answered the
    // ESTABLISHED question as a side effect of answering the routing one, and
    // deriving it here would have been a re-derivation that could drift. That
    // gate no longer HAS an `onboarding` verdict — a never-onboarded project
    // opens the workspace like any other, because whether it can be planned is
    // the planner's judgement (MOTIR-4767) — so there is nothing left to borrow.
    // `hasActiveProject` and `canBrowse` were true by construction here anyway
    // (the key resolved and `getByKey` asserted browse), which is why the call
    // only ever contributed the marker branch this line now makes directly.
    const planningGate: ProjectPlanningGateDto = project.onboardingRanAt
      ? 'workspace'
      : 'onboarding';

    const code = await resolveCodeState(ctx);
    const repoSet = await projectRepoSetService.listByProject(project.id, ctx);
    const run = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      migrateOnboardingRepository.findByProjectId(project.id, ctx.workspaceId, tx),
    );
    // The organisation's CONTENT LANGUAGE (MOTIR-8746), through the same
    // bound-workspace function every content-language reader uses — the project
    // was resolved inside `ctx.workspaceId`, so its organisation is that one.
    const contentLanguage = toOrgContentLanguage(
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        organizationRepository.findContentLanguageByWorkspaceId(ctx.workspaceId, tx),
      ),
    );

    return {
      project: {
        key: project.identifier,
        id: project.id,
        name: project.name,
        onboardingRanAt: project.onboardingRanAt,
      },
      planningGate,
      code,
      repoSet,
      onboarding: run ? toMigrateOnboardingDto(run) : null,
      contentLanguage,
    };
  },
};
