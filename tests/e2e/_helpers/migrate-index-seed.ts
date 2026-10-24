// Seed helpers for the migrate wizard's INDEX-step E2E (Story MOTIR-1981 ·
// MOTIR-1993).
//
// The Index step renders one row per CONNECTED repo and flips it to `indexed`
// off the LEDGER — a succeeded `system.code-graph-index` `job_run` whose
// `output.repoRef` matches (`jobRunRepository.findSucceededCodeGraphIndex`).
// That ledger row is the whole contract between the container path and the
// surface (`docs/decisions/code-graph-index-fleet.md` §6: one `job_run` per
// repo, `succeeded`, with one `output.repoRef`), so it is what this spec drives.
//
// TWO SEEDS, BOTH ON SHIPPED PATHS:
//
//   * The connected repo set goes through `githubInstallationService
//     .persistInstallation` — the exact function the post-install setup flow and
//     the webhook grant mirror call, and the one `resolveCodeContext` reads back
//     (the same sanctioned service import `github-seed.ts` uses).
//
//   * The ledger rows are written DIRECTLY (`db.jobRun`), exactly as
//     `jobs-dashboard.spec.ts` seeds its runs. The wizard is a READ surface over
//     this ledger; the WRITER (boot → poll → settle against the orchestrator
//     port) is the vitest gate's altitude, because `bootIndexContainer` first
//     mints a motir-ai run credential and resolves a GitHub pre-signed tarball
//     URL — neither of which has an E2E seam, and neither of which the surface
//     under test can observe except through the row it leaves behind.
//
// The E2E server selects the FAKE orchestrator through the shipped config seam
// (`MOTIR_FLEET_ORCHESTRATOR=fake` in playwright.config.ts), so nothing in this
// lane can reach Fly, need a fleet token, or boot a real container.

import { db } from '@/lib/db';
import { adminDb } from '@/tests/helpers/adminDb';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { repoRefOf } from '@/lib/github/indexEnqueue';

/** The index lane's OWN synthetic installation — deliberately not the shared
 *  `E2E_INSTALLATION_ID`, so this spec's repo set can never be perturbed by (or
 *  perturb) the github lane's single-repo reconcile. */
export const E2E_INDEX_INSTALLATION_ID = '99001993';
export const E2E_INDEX_ACCOUNT = { login: 'moooon-index-e2e', type: 'Organization' } as const;

/** THREE repos, because the assertion that matters is per-repo: a surface that
 *  batched its dispatch, or that read the ledger aggregate instead of matching
 *  `output.repoRef`, passes with one repo and fails with three. */
export const E2E_INDEX_REPOS = [
  {
    providerRepoId: '88001993',
    owner: E2E_INDEX_ACCOUNT.login,
    name: 'storefront',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '88001994',
    owner: E2E_INDEX_ACCOUNT.login,
    name: 'billing-api',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '88001995',
    owner: E2E_INDEX_ACCOUNT.login,
    name: 'shared-ui',
    defaultBranch: 'main',
    archived: false,
  },
] as const;

export type IndexSeedRepo = (typeof E2E_INDEX_REPOS)[number];

/** `owner/name` — the key the ledger records and the surface renders. */
export const indexRepoRef = (repo: { owner: string; name: string }): string => repoRefOf(repo);

/** Bind the synthetic installation + its repo set to a workspace — the state the
 *  real grant flow leaves behind, and what `resolveCodeContext` reads. */
export async function seedConnectedRepos(
  workspaceId: string,
  repos: readonly IndexSeedRepo[] = E2E_INDEX_REPOS,
): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: E2E_INDEX_INSTALLATION_ID,
      accountLogin: E2E_INDEX_ACCOUNT.login,
      accountType: E2E_INDEX_ACCOUNT.type,
    },
    repos: repos.map((repo) => ({ ...repo })),
  });
}

/**
 * Reconcile the installation down to NO repos — the user removed every
 * repository from the grant. Runs through the same `persistInstallation`
 * reconcile (its `deleteExcept` prunes the lot), so the empty state the wizard
 * then renders is reached the way the product reaches it, not by deleting rows
 * behind the app's back.
 */
export async function disconnectAllRepos(workspaceId: string): Promise<void> {
  await seedConnectedRepos(workspaceId, []);
}

let ledgerSeq = 0;

/** The shape `defineJob` writes for this function id. `eventId` is unique per
 *  row so the correlation index behaves as it does in production. */
function ledgerRow(workspaceId: string, status: 'running' | 'succeeded' | 'failed') {
  ledgerSeq += 1;
  return {
    workspaceId,
    functionId: 'system.code-graph-index',
    eventName: 'system.code-graph-index',
    eventId: `e2e-index-${ledgerSeq}`,
    lane: 'engine' as const,
    attempt: 0,
    status,
  };
}

/**
 * A container is IN FLIGHT. A `running` row carries no `output` at all — the
 * ledger cannot say which repo it belongs to — which is exactly why
 * `MigrateIndexStatusDto.hasRunning` is aggregate and per-repo status is not.
 */
export async function recordIndexRunning(workspaceId: string): Promise<string> {
  const row = await db.jobRun.create({ data: ledgerRow(workspaceId, 'running') });
  return row.id;
}

/**
 * A repo's container exited 0: the run succeeds and claims the repo with ONE
 * `output.repoRef`. This is the only thing that turns a row `indexed`.
 */
export async function recordIndexSucceeded(
  workspaceId: string,
  repoRef: string,
  runningRowId?: string,
): Promise<void> {
  const finishedAt = new Date();
  if (runningRowId) {
    await db.jobRun.update({
      where: { id: runningRowId },
      data: {
        status: 'succeeded',
        finishedAt,
        durationMs: 4200,
        output: { indexed: true, repoRef, projectsIndexed: 1 },
      },
    });
    return;
  }
  await db.jobRun.create({
    data: {
      ...ledgerRow(workspaceId, 'succeeded'),
      finishedAt,
      durationMs: 4200,
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

/**
 * A repo's container did NOT exit 0 — `IndexDispatchFailedError` reached the
 * job, so the run FAILS and writes **no `output`** (`defineJob` writes `output`
 * on the success path only). That absence is the ledger contract's teeth: a
 * failed index leaves nothing that could tell the wizard the repo has a graph.
 *
 * `repoRef` rides the failure MESSAGE, never `output` — the same place the real
 * error puts it — so a surface that "helpfully" read the repo out of a failed
 * row would be caught by the assertions that follow this call.
 */
export async function recordIndexFailed(
  workspaceId: string,
  repoRef: string,
  runningRowId?: string,
): Promise<void> {
  const failure = {
    message:
      `Indexing ${repoRef} into project e2e failed (graph_unbuildable): ` + 'the indexer exited 30',
    name: 'IndexDispatchFailedError',
  };
  const finishedAt = new Date();
  if (runningRowId) {
    await db.jobRun.update({
      where: { id: runningRowId },
      data: { status: 'failed', finishedAt, durationMs: 3100, failure },
    });
    return;
  }
  await db.jobRun.create({
    data: { ...ledgerRow(workspaceId, 'failed'), finishedAt, durationMs: 3100, failure },
  });
}

/**
 * Point a connected repo's index CLAIM at a ledger row (Story MOTIR-8246). The
 * per-repo status reads the run its `github_repo.indexing_run_id` names, so a
 * `running` or `failed` row only lands on a repo once the repo claims it — the
 * state the index dispatch leaves behind when it starts that repo's container.
 */
export async function claimIndexRun(
  workspaceId: string,
  repo: { owner: string; name: string },
  runId: string,
): Promise<void> {
  await adminDb.githubRepo.updateMany({
    where: { workspaceId, owner: repo.owner, name: repo.name },
    data: { indexingRunId: runId },
  });
}
