import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  CI_RUNNER_INTENT_FAILED,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { ciActionsGateService } from '@/lib/services/ciActionsGateService';
import { actionsRunsClient, type ActionsRepoRef } from '@/lib/github/actionsRuns';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { fleetRunnerTargetFor } from '@/lib/ciFleet/runnerTarget';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import {
  githubRunnerCallLedgerService as runnerCallLedger,
  runnerCallReachedGithub,
} from '@/lib/services/githubRunnerCallLedgerService';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import { isOrchestratorConfigured, recordContainerUsage } from '@/lib/orchestrator';
import {
  FLEET_CONTAINER_SIZE,
  type ContainerHandle,
  type ContainerOrchestrator,
  type OrchestratorProvider,
} from '@motir/orchestrator';

// STOP ONE ORGANISATION'S FLEET (Story MOTIR-6906 · MOTIR-6908) —
// `docs/decisions/fleet-per-org-pool.md`: at zero, an org's running jobs are
// cancelled and its machines destroyed.
//
// Before this, nothing in Motir could stop a job that was ALREADY running: the
// credit refusal only declined the next boot, and the Actions pause only stopped
// the next dispatch. This is written once and called twice — by the automatic
// stop at zero credits (MOTIR-6911) and by a platform admin halting one org
// (MOTIR-6905) — so both get the same order, the same idempotence and the same
// partial-failure posture.
//
// ⚠️ THE ORDER IS THE CORRECTNESS PROPERTY: CANCEL RUNS FIRST, THEN TEAR DOWN.
// A container torn down under a job that is still live leaves that job queued,
// and a queued job asks the fleet for another runner — the stop would provision
// the very thing it just destroyed. Cancelling first ends the jobs, so nothing
// re-requests a runner by the time the containers go.
//
// ⚠️ EVERY FAILURE IS LOGGED AND SKIPPED, never thrown. One repository GitHub
// refuses must not leave the other repositories' runs going, and one container
// the provider will not destroy must not leave the rest running on a zero
// balance. A container whose teardown failed stays IN FLIGHT, which is what hands
// it to the reaper; settling it would hide a machine that may still be running.
//
// ⚠️ IDEMPOTENT. A second call finds no live run and no in-flight intent and
// returns zeros, so the caller never has to know whether a stop already ran.

/** Why an org's fleet was stopped. Recorded as each torn-down intent's
 *  `teardownReason`. */
export type FleetStopReason = 'credits_exhausted' | 'admin_stop';

export interface FleetStopResult {
  /** Workflow runs GitHub accepted a cancel for. */
  runsCancelled: number;
  /** CI containers torn down, and their intents settled. */
  containersStopped: number;
  /** Repositories whose runs could not be listed or cancelled, and containers
   *  that could not be torn down — each already logged. */
  failures: number;
}

const CI_RUNNER_WORKLOAD = 'ci_runner' satisfies FleetWorkloadKind;

const STOP_DETAIL: Record<FleetStopReason, string> = {
  credits_exhausted: "the organization's fleet was stopped at zero credits",
  admin_stop: "the organization's fleet was stopped by a platform admin",
};

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const fleetStopService = {
  /**
   * Cancel every live workflow run on the org's Motir-hosted repositories, then
   * tear down every CI container the org holds and settle its intent.
   */
  async stopOrganization(
    organizationId: string,
    reason: FleetStopReason,
    options: { now?: () => Date } = {},
  ): Promise<FleetStopResult> {
    const now = options.now ?? (() => new Date());
    const result: FleetStopResult = { runsCancelled: 0, containersStopped: 0, failures: 0 };

    // ── 1 · cancel the runs, so no job re-requests a runner ───────────────────
    for (const repo of await this.listHostedRepos(organizationId)) {
      try {
        for (const run of await actionsRunsClient.listActiveRuns(repo)) {
          if (await actionsRunsClient.cancelRun(repo, run.id)) result.runsCancelled += 1;
        }
      } catch (err) {
        result.failures += 1;
        console.error('[fleetStopService] could not cancel the runs of a repository', {
          organizationId,
          repo: `${repo.owner}/${repo.repo}`,
          reason,
          detail: detailOf(err),
        });
      }
    }

    // ── 2 · tear down the containers, and settle their intents ────────────────
    const inFlight = await withSystemContext((tx) =>
      intents.listInFlightForOrganization(organizationId, tx),
    );
    if (inFlight.length === 0) return result;

    // Each container is torn down through the account it was booted in
    // (MOTIR-8964); a legacy intent through the process-wide fleet.
    const orchestratorFor = async (
      intent: CiRunnerProvisioningIntent,
    ): Promise<ContainerOrchestrator | null> => {
      if (intent.fleetShardId === null && !isOrchestratorConfigured()) return null;
      try {
        return await fleetShardOrchestratorService.forIntent(intent);
      } catch (err) {
        console.error('[fleetStopService] no orchestrator — container left for the reaper', {
          organizationId,
          intentId: intent.id,
          detail: detailOf(err),
        });
        return null;
      }
    };

    for (const intent of inFlight) {
      const stopped = await stopIntent(intent, reason, await orchestratorFor(intent), now);
      if (stopped === 'stopped') result.containersStopped += 1;
      if (stopped === 'failed') result.failures += 1;
    }

    return result;
  },

  /**
   * The org's repositories Motir created in its own GitHub org — the only ones
   * whose runs are Motir's to cancel. The traversal is mirror → workspace → org
   * (`ciActionsGateService.listOwnedWorkspaceIds` says why no other direction is
   * readable from a background path), and the owner is re-checked per row: a
   * repository handed off out of Motir's org is the user's.
   *
   * Each ref carries GitHub's NUMERIC installation id (MOTIR-10071). The mirror's
   * `installationId` is the foreign key to `GithubInstallation.id`, a cuid GitHub
   * never issued — a token minted for it is a 404, so no run would ever be
   * listed or cancelled. It is resolved under `withSystemContext`: the
   * provisioning installation Motir-created repositories live in is shared and
   * has no `workspace_id`, so a tenant context cannot read it.
   */
  async listHostedRepos(organizationId: string): Promise<ActionsRepoRef[]> {
    if (!provisioningOrgLogin()) return [];
    // Every org Motir owns — a fleet account's too (MOTIR-8974).
    const owners = await motirOwnedOrgLogins();
    const workspaceIds = await ciActionsGateService.listOwnedWorkspaceIds(organizationId, owners);
    const hosted: { installationRowId: string; owner: string; repo: string }[] = [];
    for (const workspaceId of workspaceIds) {
      const rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
        projectRepoRepository.listMotirCreatedByWorkspace(workspaceId, tx),
      );
      for (const row of rows) {
        const repo = row.githubRepo;
        if (!repo || !isMotirHostedOwner(repo.owner, owners)) continue;
        hosted.push({ installationRowId: repo.installationId, owner: repo.owner, repo: repo.name });
      }
    }
    if (hosted.length === 0) return [];

    const hostInstallationIds = await withSystemContext((tx) =>
      githubInstallationRepository.findHostInstallationIdsByIds(
        hosted.map((row) => row.installationRowId),
        tx,
      ),
    );
    const repos: ActionsRepoRef[] = [];
    for (const { installationRowId, owner, repo } of hosted) {
      const installationId = hostInstallationIds.get(installationRowId);
      // The mirror row cascades with its installation, so a miss is an
      // installation removed between the two reads — its repositories with it.
      if (!installationId) {
        console.error('[fleetStopService] a hosted repository has no installation on record', {
          organizationId,
          repo: `${owner}/${repo}`,
        });
        continue;
      }
      repos.push({ installationId, owner, repo });
    }
    return repos;
  },
};

/**
 * Stop one in-flight intent. `stopped` when a container was torn down (or there
 * was none yet) and the intent settled; `failed` when the teardown failed and the
 * intent was left in flight for the reaper; `skipped` when someone else settled
 * it first.
 */
async function stopIntent(
  intent: CiRunnerProvisioningIntent,
  reason: FleetStopReason,
  orchestrator: ContainerOrchestrator | null,
  now: () => Date,
): Promise<'stopped' | 'failed' | 'skipped'> {
  const hasContainer = intent.containerProvider !== null && intent.containerId !== null;

  if (hasContainer) {
    if (!orchestrator) return 'failed';
    const handle: ContainerHandle = {
      provider: intent.containerProvider as OrchestratorProvider,
      id: intent.containerId as string,
      region: intent.containerRegion ?? '',
      createdAt: intent.bootedAt ?? intent.createdAt,
    };
    const workflowJobId = Number(intent.jobId);
    try {
      // `gate_revoked` is the provider-side vocabulary for "Motir withdrew this
      // container's permission to run"; the org-side why is the intent's reason.
      const usage = await orchestrator.teardown(handle, 'gate_revoked', {
        orgId: intent.organizationId,
        workspaceId: intent.workspaceId,
        projectId: intent.projectId ?? '',
        repoFullName: `${intent.repoOwner}/${intent.repoName}`,
        workload: CI_RUNNER_WORKLOAD,
        workflowJobId: Number.isInteger(workflowJobId) ? workflowJobId : null,
        size: FLEET_CONTAINER_SIZE,
        observedStartedAt: intent.startedAt,
      });
      // A project-less intent has nothing to attribute a cost row to — the same
      // null the reaper's resolver answers for it.
      if (intent.projectId) await recordContainerUsage(usage);
    } catch (err) {
      console.error('[fleetStopService] could not tear down a container — left for the reaper', {
        organizationId: intent.organizationId,
        intentId: intent.id,
        containerId: handle.id,
        reason,
        detail: detailOf(err),
      });
      return 'failed';
    }
  }

  if (intent.githubRunnerId !== null) {
    try {
      // In the org that owns the job's repository (MOTIR-8711).
      await runnerJitConfigClient.deleteRunner(intent.githubRunnerId, fleetRunnerTargetFor(intent));
      await runnerCallLedger.recordForTargetQuietly(
        fleetRunnerTargetFor(intent),
        'delete',
        intent.fleetShardId,
      );
    } catch (err) {
      if (runnerCallReachedGithub(err)) {
        await runnerCallLedger.recordForTargetQuietly(
          fleetRunnerTargetFor(intent),
          'delete',
          intent.fleetShardId,
        );
      }
      console.error('[fleetStopService] could not de-register a runner', {
        intentId: intent.id,
        runnerId: intent.githubRunnerId,
        detail: detailOf(err),
      });
    }
  }

  const settled = await withSystemContext((tx) =>
    intents.settle(
      intent.id,
      {
        status: CI_RUNNER_INTENT_FAILED,
        teardownReason: reason,
        settledAt: now(),
        failureDetail: STOP_DETAIL[reason],
      },
      tx,
    ),
  );
  if (!settled) return 'skipped';
  return hasContainer ? 'stopped' : 'skipped';
}
