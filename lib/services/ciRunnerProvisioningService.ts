import { Prisma } from '@/generated/prisma/client';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { bindOrganizationContext } from '@/lib/organizations/context';
import type {
  NormalizedWorkflowJobEvent,
  NormalizedWorkflowJobProgressEvent,
} from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import {
  ciRunnerProvisioningIntentRepository,
  type CiRunnerProvisioningIntentCreateInput,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { isMotirFleetJob } from '@/lib/ciFleet/config';
import {
  provisioningInstallationIdFor,
  RepoProvisioningApiError,
  RepoProvisioningNotConfiguredError,
} from '@/lib/github/repoProvisioning';

// The runner-FLEET ENTRY POINT (Story MOTIR-1916 · MOTIR-1920) — turning a
// `workflow_job` `queued` delivery into an attributed provisioning intent, or,
// far more often, into a deliberate no-op.
//
// `docs/decisions/ci-minutes-allowance.md`'s 2026-07-31 amendment moves project
// CI onto Motir-operated ephemeral runners. A job that wants one announces
// itself by queueing; this service decides whether that job is OURS to serve and
// records the request durably so MOTIR-1921 can boot a machine for it.
//
// ⚠️ IT BOOTS NOTHING AND SPENDS NOTHING. No runner is registered, no token is
// minted, no cap is consulted, no credit is read — those are MOTIR-1921's and
// MOTIR-1922's, and the seam between them is exactly ONE read:
// `ciRunnerProvisioningIntentRepository.listPending`.
//
// The pipeline, and where each step is decided:
//
//   1. Is it OURS?      §O   — the requested LABELS name the Motir runner. The
//                              whole point of the card; everything else is
//                              dropped at debug level, without an error.
//   2. Whom for?        §5.2 — repo → project-repo row → project → workspace →
//                              org, the same chain the meter walks.
//   3. Already seen?    §5.8 — a cheap pre-check; the unique index is the guard.
//   4. Record it.              One insert. That is the deliverable.

/** Whom a queued fleet job belongs to — the §5.2 chain's output. */
interface Attribution {
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  githubRepoId: string;
}

export type RecordQueuedJobOutcome =
  /** The job's requested labels do not name the Motir runner — a GitHub-hosted
   *  job, which is the overwhelming majority of deliveries. NOT an error, and
   *  deliberately the first branch: §J's scope boundary lives here. */
  | { outcome: 'not_fleet_job'; requestedLabels: string[] }
  /** The delivery names an installation or repo Motir has no mirror row for. */
  | { outcome: 'unknown_installation' }
  | { outcome: 'unknown_repo' }
  /** A fleet-labelled job in a repo that resolves to no tenant — a repo whose
   *  project was deleted, or one belonging to none. LOGGED, never provisioned
   *  (§5.4's posture, applied one step earlier: real compute with no owner). */
  | { outcome: 'unattributed'; repoOwner: string; repoName: string }
  /** This exact job of this exact run attempt already has an intent (§5.8). */
  | { outcome: 'duplicate'; runId: string; runAttempt: number; jobId: string }
  | {
      outcome: 'recorded';
      intentId: string;
      runId: string;
      runAttempt: number;
      jobId: string;
      organizationId: string;
      workspaceId: string;
      projectId: string | null;
    };

export const ciRunnerProvisioningService = {
  /**
   * Handle ONE queued job. `installationId` is the App installation the delivery
   * arrived on — stored on the intent because MOTIR-1921 mints the runner
   * registration token with it.
   *
   * Never throws for a job it simply does not serve: every "no" is a typed
   * outcome the webhook logs, because a webhook that 500s makes GitHub retry a
   * delivery there was never anything to do for.
   */
  async recordQueuedJob(
    event: NormalizedWorkflowJobEvent,
    installationId: string,
  ): Promise<RecordQueuedJobOutcome> {
    // 1 · §O — THE GATE. Scope by the job's requested LABELS, not by receipt of
    // an event, not by repository owner, and not by tenant flag.
    //
    // It runs FIRST, before a single DB read, and that ordering is the design:
    // every `motir-core` job — 31 per run, at ~10 runs a day — delivers a
    // `queued` event here, and none of them should cost a query, let alone a
    // runner. Owner alone would not do: `isMotirOwnedRepo` is true for every
    // repo in the provisioning org, and would stay true for a repo added to it
    // later that is still meant to run GitHub-hosted. The label is what the
    // workflow actually ASKED for.
    //
    // `isMeta` is deliberately NOT consulted (§O's axis table): the tenant flag
    // lives behind the repo → project → workspace → org join this branch runs
    // before, and for a repo with no project row there is no tenant to read at
    // all. The exclusion has to be answerable from the payload, and the label is.
    if (!isMotirFleetJob(event.requestedLabels)) {
      return { outcome: 'not_fleet_job', requestedLabels: event.requestedLabels };
    }

    // 2 · §5.2 — resolve the tenant. TWO contexts, one per hop, because the
    // shipped RLS policies gate differently and only the mirror tables carry the
    // `app.system_admin` escape:
    //
    //   * `github_installation` / `github_repo` — policy is
    //     `system_admin OR workspace_id = …`, so the webhook (no session, no
    //     active workspace) reads them under `withSystemContext`.
    //   * `project_repository` / `workspace` — neither has a system escape, so
    //     `withSystemContext` would read NOTHING here in production (where the
    //     app connects as the non-BYPASSRLS `motir_app` role) and every job
    //     would resolve to "unattributed". They are read under
    //     `withWorkspaceServiceContext` bound to the REPO's workspace, PLUS
    //     `bindOrganizationContext` — MOTIR-4839, and the attribution block
    //     below carries which arm each table needs.
    //
    // ⚠️ The REPO row is the tenant, never the installation (MOTIR-1931,
    // `notes.html` #186). Under Motir's shared provisioning installation
    // `GithubInstallation.workspaceId` is NULL and names no workspace at all —
    // reading it here would attribute every tenant's jobs to nobody.
    const mirrored = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { kind: 'unknown_installation' as const };
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        event.providerRepoId,
        tx,
      );
      if (!repo) return { kind: 'unknown_repo' as const };
      return {
        kind: 'connected' as const,
        workspaceId: repo.workspaceId,
        // Carried out for the attribution transaction's organisation binding
        // (MOTIR-4839). NOT NULL on `github_repo` as of 20260907090000.
        organizationId: repo.organizationId,
        githubRepoId: repo.id,
      };
    });

    // 2b · The CONNECTED-ORG fallback (MOTIR-8720). An installation with no
    // mirror row is, in one case, still Motir's to serve: the PROVISIONING App
    // installed on an org whose repositories are mirrored under ANOTHER App's
    // installation (a `connected` repo reached through Motir Integration, while
    // only the provisioning App subscribes to `workflow_job`). The fallback is
    // keyed on PROOF, never on the missing row alone — the delivery's
    // installation must BE the provisioning App's installation on the repo's
    // owner, read with the App JWT — so no other App's installation can turn a
    // forged label into a billed machine. Every other installation miss is
    // refused exactly as before.
    const connection =
      mirrored.kind === 'unknown_installation'
        ? await resolveConnectedOrgRepo(event, installationId)
        : mirrored;

    if (connection.kind === 'unknown_installation') {
      console.warn(
        '[ciRunnerProvisioningService] fleet-labelled job on an unknown installation — not provisioned',
        {
          installationId,
          repoOwner: event.repoOwner,
          repoName: event.repoName,
          ...('reason' in connection ? { reason: connection.reason } : {}),
        },
      );
      return { outcome: 'unknown_installation' };
    }
    if (connection.kind === 'unknown_repo') {
      console.warn(
        '[ciRunnerProvisioningService] fleet-labelled job in a repo Motir does not mirror — not provisioned',
        {
          installationId,
          repoOwner: event.repoOwner,
          repoName: event.repoName,
          ...('reason' in connection ? { reason: connection.reason } : {}),
        },
      );
      return { outcome: 'unknown_repo' };
    }

    const tenant = await withWorkspaceServiceContext(connection.workspaceId, async (tx) => {
      // ⚠️ BIND THE ORGANISATION TOO (MOTIR-4839 · bug MOTIR-4835) — the same
      // edit, for the same reason, as `ciMinutesMeterService`, whose block
      // carries the full account. In short: MOTIR-4669 made a repository
      // ORG-owned, so the link row's workspace is routinely NOT the repository's,
      // and the workspace GUC bound above admits neither the
      // `project_repository` row (`project_repository_org_read`, 20260906000000)
      // nor the anchor's `workspace` row (`workspace_org_service_read`,
      // 20260818010000 — the userless arm, which is what a service context is).
      // Both arms are FOR SELECT, so this widens reads to the ORGANISATION and no
      // further: a link in another org stays invisible.
      //
      // ⚠️ IT IS THE SAME EDIT ON PURPOSE. The note below says these two sites
      // must not answer differently; this binding is part of the answer, so a
      // change here that does not land there — or the reverse — recreates exactly
      // the divergence that note exists to prevent, silently, because both sides
      // of it are legitimate-looking null returns.
      await bindOrganizationContext(tx, connection.organizationId);

      // ⚠️ ATTRIBUTION, and the SAME disposition as the meter's (MOTIR-4648) —
      // the two sites ask one question and must not answer it differently.
      // `ProjectRepo.githubRepoId` is no longer `@unique`, so:
      //   0 rows → unattributed (the job is REFUSED below, which is this path's
      //            own posture — the money has not been spent yet).
      //   1 row  → that project. Unchanged.
      //   N rows → the organisation owns the fleet cost and is charged; the
      //            project is unknown and recorded as null. `project_id` is
      //            nullable on `ci_runner_provisioning_intent` for this.
      // Provisioning is NOT refused on ambiguity: an org-owned repository shared
      // by two projects is a legitimate shape, and refusing its jobs would turn a
      // supported model into an outage.
      const projectRepos = await projectRepoRepository.listByGithubRepoId(
        connection.githubRepoId,
        tx,
      );
      if (projectRepos.length === 0) return null;
      const anchor = projectRepos[0]!;
      const workspace = await workspaceRepository.findByIdInTx(anchor.workspaceId, tx);
      if (!workspace) return null;
      if (projectRepos.length > 1) {
        console.warn(
          '[ciRunnerProvisioningService] repository is used by several projects — provisioning for the org, project left null',
          { githubRepoId: connection.githubRepoId, projectCount: projectRepos.length },
        );
      }
      return {
        workspaceId: anchor.workspaceId,
        organizationId: workspace.organizationId,
        projectId: projectRepos.length === 1 ? anchor.projectId : null,
      };
    });

    if (!tenant) {
      // A job asking for a Motir runner that belongs to no tenant would be
      // compute spent on nobody's behalf, uncapped and uncharged — so it is
      // REFUSED rather than merely logged, which is the one place this path
      // diverges from the meter's §5.4 posture. The meter records a cost GitHub
      // has already charged and cannot un-charge; here the money has not been
      // spent yet, and declining is free. The warning is still mandatory: a
      // fleet-labelled job with no owner means a repo was created or moved
      // outside the repo-set path, and silence would hide that.
      console.warn(
        '[ciRunnerProvisioningService] fleet-labelled job has no attributable project — not provisioned',
        {
          repoOwner: event.repoOwner,
          repoName: event.repoName,
          runId: event.runId,
          runAttempt: event.runAttempt,
          jobId: event.jobId,
        },
      );
      return { outcome: 'unattributed', repoOwner: event.repoOwner, repoName: event.repoName };
    }

    const attribution: Attribution = {
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      githubRepoId: connection.githubRepoId,
    };

    // 3 · A cheap redelivery pre-check. NOT the correctness guard — two
    // concurrent deliveries would both miss it; the unique index at step 4 is
    // what guarantees once.
    const already = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.findByJobKey(
        event.runId,
        event.runAttempt,
        event.jobId,
        tx,
      ),
    );
    if (already) {
      return {
        outcome: 'duplicate',
        runId: event.runId,
        runAttempt: event.runAttempt,
        jobId: event.jobId,
      };
    }

    const input: CiRunnerProvisioningIntentCreateInput = {
      workspaceId: attribution.workspaceId,
      organizationId: attribution.organizationId,
      projectId: attribution.projectId,
      githubRepoId: attribution.githubRepoId,
      installationId,
      runId: event.runId,
      runAttempt: event.runAttempt,
      jobId: event.jobId,
      jobName: event.jobName,
      workflowName: event.workflowName,
      // The repo identity AS THE DELIVERY REPORTED IT (§5.5), never the mirror's.
      repoOwner: event.repoOwner,
      repoName: event.repoName,
      requestedLabels: event.requestedLabels,
      queuedAt: event.queuedAt,
    };

    try {
      const intent = await withSystemContext((tx) =>
        ciRunnerProvisioningIntentRepository.create(input, tx),
      );
      return {
        outcome: 'recorded',
        intentId: intent.id,
        runId: event.runId,
        runAttempt: event.runAttempt,
        jobId: event.jobId,
        organizationId: attribution.organizationId,
        workspaceId: attribution.workspaceId,
        projectId: attribution.projectId,
      };
    } catch (err) {
      // The idempotency guarantee. A concurrent or retried delivery loses the
      // race on `(run_id, run_attempt, job_id)` and reports `duplicate` — which
      // matters more here than for the meter: a lost race that fell through to a
      // second intent would boot a SECOND ephemeral runner for one job, and the
      // second would idle until its timeout with no job to claim. Caught OUTSIDE
      // the transaction on purpose — a failed statement aborts the Postgres
      // transaction, so catching it inside and continuing would only produce a
      // second, more confusing error (25P02).
      if (isUniqueViolation(err)) {
        return {
          outcome: 'duplicate',
          runId: event.runId,
          runAttempt: event.runAttempt,
          jobId: event.jobId,
        };
      }
      throw err;
    }
  },

  /**
   * Record a fleet job's PROGRESS on its intent (MOTIR-11230) — the two stamps
   * the boot service's supervision reads to retire a runner that has no job.
   *
   *   - `jobPickedUpAt` is stamped on the intent whose runner GitHub assigned
   *     the job to (`runner_id`), whichever job that intent was booted for. A
   *     JIT runner is not bound to its intent's job — GitHub hands it the oldest
   *     queued job with its label — so stamping by job key would miss a runner
   *     working another intent's job, and keep an idle one alive.
   *   - `jobCompletedAt` is stamped by job key on `completed`: the job this
   *     intent was booted for is finished, so if its runner has taken nothing
   *     it never will take that job.
   *
   * Both stamps are write-once. A job outside the fleet's labels is ignored
   * before any read, exactly as {@link recordQueuedJob} gates it.
   */
  async recordJobProgress(
    event: NormalizedWorkflowJobProgressEvent,
    now: Date = new Date(),
  ): Promise<
    { outcome: 'ignored' } | { outcome: 'recorded'; pickedUp: number; completed: number }
  > {
    if (!isMotirFleetJob(event.requestedLabels)) return { outcome: 'ignored' };
    const job = { runId: event.runId, runAttempt: event.runAttempt, jobId: event.jobId };
    return withSystemContext(async (tx) => {
      const pickedUp =
        event.runnerId === null
          ? 0
          : await ciRunnerProvisioningIntentRepository.markJobPickedUpByRunner(
              event.runnerId,
              now,
              tx,
            );
      const completed =
        event.action === 'completed'
          ? await ciRunnerProvisioningIntentRepository.markJobCompleted(
              job,
              event.completedAt ?? now,
              tx,
            )
          : 0;
      return { outcome: 'recorded' as const, pickedUp, completed };
    });
  },

  /**
   * THE SEAM. The oldest intents still awaiting a runner — what MOTIR-1921's
   * provisioner consumes. Deliberately returns the rows only: no gate, no cap,
   * no boot decision. Those are the consumer's, and keeping them out is what
   * lets this half stay a pure record of what was asked for.
   */
  async listPendingIntents(limit = 50) {
    return withSystemContext((tx) => ciRunnerProvisioningIntentRepository.listPending(limit, tx));
  },
};

/** A Postgres unique-constraint violation, surfaced by Prisma as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

type ConnectedOrgResolution =
  | {
      kind: 'connected';
      workspaceId: string;
      organizationId: string;
      githubRepoId: string;
    }
  | {
      kind: 'unknown_installation';
      reason:
        | 'not_configured'
        | 'github_unreachable'
        | `github_status_${number}`
        | 'installation_mismatch';
    }
  | {
      kind: 'unknown_repo';
      reason: 'no_mirror_row' | 'ambiguous_mirror_rows' | 'owner_mismatch';
    };

/**
 * MOTIR-8720 — attribute a fleet-labelled job delivered on an installation
 * Motir has no mirror row for, IF AND ONLY IF that installation is the
 * provisioning App's installation on the repository's owner.
 *
 * 1. GitHub is asked OUTSIDE any transaction (an HTTP call never holds one open)
 *    which installation the provisioning App has on `event.repoOwner`; anything
 *    but the delivery's own id ends here.
 * 2. The repository's mirror rows are read across installations; exactly ONE is
 *    required — never `rows[0]` of several.
 * 3. That row's owner must be the delivery's owner (case-insensitive).
 *
 * The row may belong to ANY installation: the REPO row is the tenant, never the
 * installation (MOTIR-1931).
 */
async function resolveConnectedOrgRepo(
  event: NormalizedWorkflowJobEvent,
  installationId: string,
): Promise<ConnectedOrgResolution> {
  let provisioningInstallationId: string;
  try {
    provisioningInstallationId = await provisioningInstallationIdFor(event.repoOwner);
  } catch (err) {
    if (err instanceof RepoProvisioningNotConfiguredError) {
      return { kind: 'unknown_installation', reason: 'not_configured' };
    }
    if (err instanceof RepoProvisioningApiError && err.status !== null) {
      return { kind: 'unknown_installation', reason: `github_status_${err.status}` };
    }
    return { kind: 'unknown_installation', reason: 'github_unreachable' };
  }
  if (String(provisioningInstallationId) !== String(installationId)) {
    return { kind: 'unknown_installation', reason: 'installation_mismatch' };
  }

  const rows = await withSystemContext((tx) =>
    githubRepoRepository.listByRepoId(event.providerRepoId, tx),
  );
  if (rows.length === 0) return { kind: 'unknown_repo', reason: 'no_mirror_row' };
  if (rows.length > 1) return { kind: 'unknown_repo', reason: 'ambiguous_mirror_rows' };
  const repo = rows[0]!;
  if (repo.owner.toLowerCase() !== event.repoOwner.toLowerCase()) {
    return { kind: 'unknown_repo', reason: 'owner_mismatch' };
  }
  return {
    kind: 'connected',
    workspaceId: repo.workspaceId,
    organizationId: repo.organizationId,
    githubRepoId: repo.id,
  };
}
