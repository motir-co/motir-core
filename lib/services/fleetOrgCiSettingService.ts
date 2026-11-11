import 'server-only';

import { MOTIR_RUNNER_LABEL, MOTIR_RUNNER_VARIABLE } from '@/lib/ciFleet/config';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import type {
  FleetOrgCiCodeScanningDTO,
  FleetOrgCiFlipDTO,
  FleetOrgCiStateDTO,
  FleetOrgCiStoredStateDTO,
  FleetOrgCiTargetDTO,
  FleetOrgCiVariableDTO,
} from '@/lib/dto/fleetOrgCiSetting';
import {
  ActionsVariableApiError,
  actionsVariableClient,
  type OrgVariable,
} from '@/lib/github/actionsVariables';
import {
  CodeScanningDefaultSetupApiError,
  codeScanningDefaultSetupClient,
  runnerRequests,
  type DefaultSetup,
  type DefaultSetupRunner,
} from '@/lib/github/codeScanningDefaultSetup';
import { OrgTargetAuthError, type GithubOrgTarget } from '@/lib/github/orgTarget';
import {
  findProvisioningInstallationId,
  RepoProvisioningApiError,
} from '@/lib/github/repoProvisioning';
import { RepoVisibilityApiError, repoVisibilityClient } from '@/lib/github/repoVisibility';
import { toFleetOrgCiStoredStateDTO } from '@/lib/mappers/fleetOrgCiSettingMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformWrite, type PlatformAuditEntry } from '@/lib/platform/context';
import {
  FleetOrgCiCodeScanningError,
  FleetOrgCiGithubWriteError,
  FleetOrgCiNotReadyError,
  FleetOrgCiTargetUnknownError,
} from '@/lib/platform/errors';
import { platformFleetOrgCiRepository } from '@/lib/repositories/platformFleetOrgCiRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { fleetReadinessService } from '@/lib/services/fleetReadinessService';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

/**
 * The platform setting "Run Motir's private repositories' CI on the fleet"
 * (Story MOTIR-8699 · MOTIR-8714).
 *
 * One row per (project, connected org) holds the operator's INTENT; the org's
 * `MOTIR_RUNNER` Actions variable is its EFFECT. ON writes the variable (private,
 * `MOTIR_RUNNER_LABEL`) after the readiness verdict passes; OFF deletes it so
 * `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` falls back to
 * GitHub-hosted, and OFF never waits on readiness — it is also the recovery path
 * when the fleet breaks. Running jobs are untouched either way: the variable
 * changes only what NEW jobs request. Only a `superadmin` reads or flips it.
 *
 * ⚠️ `listTargets` IS THE ONE PLACE IN THE STORY THAT READS ORG IDENTITY, on
 * purpose: the platform decides WHOSE CI the console may move (projects of the
 * meta organisation, orgs other than the provisioning org). Every fleet path
 * below it receives only `{ projectId, org, installationId }`.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND THE ONE RESIDUAL CASE
 * ---------------------------------------------------------------------------
 * `setModel`'s order (`platformPlannerModelService`), with the GitHub write
 * inside the audited transaction so a refusal rolls the row back. The audit row
 * is appended AFTER the write (`withPlatformWrite`, which takes the chain lock
 * first), because its metadata carries what the write did (`variableOutcome`).
 * Holding the chain lock across the flip's GitHub round trips is the accepted
 * cost for a rarely used switch; it also serialises two flips of one pair.
 *
 * ⚠️ THE TRANSACTION IS GIVEN A DEADLINE SIZED TO ITS GITHUB WRITES
 * (MOTIR-10972). Prisma's interactive default is 5 s, and one flip makes up to
 * three variable requests plus one PATCH per default-setup move: a pair with
 * three repositories to move outlived it, the expired transaction fell through
 * to a bare `FAILED`, and the flip could not be made from the console at all.
 * {@link flipTransactionTimeoutMs} grows with the moves the flip plans. A GitHub
 * call that outlasts even that deadline is still safe: Postgres rolls the
 * transaction back (releasing the chain lock), the callback's next statement
 * fails, and the compensation below puts back everything that had moved.
 *
 * GitHub applied the write and core's commit then failed: nothing makes the two
 * atomic, so the service COMPENSATES by restoring the variable it read before the
 * transaction. If that also fails, GitHub and the stored state disagree; a
 * constant message with the pair is logged and `getState`'s `variable` read makes
 * the drift visible afterwards.
 *
 * ---------------------------------------------------------------------------
 * CODEQL DEFAULT SETUP TRAVELS WITH THE FLIP (MOTIR-10289)
 * ---------------------------------------------------------------------------
 * The variable moves every job a workflow FILE declares. CodeQL's default setup
 * has no file: its `Analyze` jobs ask for whatever runner the repository's
 * default-setup setting names, and they never read `MOTIR_RUNNER`. So the flip
 * moves that setting too, for each private repository of the pair whose default
 * setup is CONFIGURED: ON puts it on `labeled` + `MOTIR_RUNNER_LABEL`, OFF puts a
 * repository on that label back on `standard`. A repository already where the
 * flip wants it, one whose default setup is not configured, and one without code
 * scanning are left exactly as they are — the flip never configures CodeQL.
 * The settings are read before the transaction (with the variable, for
 * compensation) and written inside it after the variable, under the same rule: a
 * failed read or write refuses the flip, nothing is stored, and whatever was
 * already moved on GitHub is put back.
 *
 * ⚠️ BOOT IS NOT GATED HERE. A job that requests `motir-runner` still boots
 * whatever the switch says (`lib/ciFleet/config.ts`, "AND NOT BY TENANT FLAG");
 * the switch controls what jobs REQUEST, never what the fleet serves.
 */

const LOG = '[fleet-org-ci-setting]';

/** The pair a caller names. */
export interface FleetOrgCiPair {
  projectId: string;
  org: string;
}

/** Thrown inside the transaction when the re-read under the lock already holds
 *  the asked state, so the transaction (and its row) rolls back. */
class UnchangedUnderLock extends Error {}

function statusOf(err: unknown): number | null {
  if (
    err instanceof ActionsVariableApiError ||
    err instanceof CodeScanningDefaultSetupApiError ||
    err instanceof OrgTargetAuthError ||
    err instanceof RepoVisibilityApiError ||
    err instanceof RepoProvisioningApiError
  ) {
    return err.status;
  }
  return null;
}

function isGithubFailure(err: unknown): boolean {
  return (
    err instanceof ActionsVariableApiError ||
    err instanceof CodeScanningDefaultSetupApiError ||
    err instanceof OrgTargetAuthError ||
    err instanceof RepoVisibilityApiError ||
    err instanceof RepoProvisioningApiError
  );
}

function orgTargetFor(target: FleetOrgCiTargetDTO): GithubOrgTarget {
  return { org: target.org, installationId: target.installationId, role: 'provisioning' };
}

/**
 * Every pair the console offers: each meta-org project × each owner org of its
 * established PRIVATE repositories other than the provisioning org, where the
 * provisioning App is installed. A GitHub failure reading visibility throws
 * `FleetOrgCiGithubWriteError` (`read`) rather than silently hiding an org.
 */
async function offeredTargets(): Promise<FleetOrgCiTargetDTO[]> {
  const owned = await motirOwnedOrgLogins();
  const projects = await withSystemContext((tx) => projectRepository.listInMetaOrganizations(tx));
  const targets: FleetOrgCiTargetDTO[] = [];
  for (const project of projects) {
    const realized = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      projectRepoRepository.listEstablishedRealizedRepos(project.id, project.workspaceId, tx),
    );
    const byOrg = new Map<string, typeof realized>();
    for (const repo of realized) {
      const key = repo.owner.trim().toLowerCase();
      if (!key || isMotirHostedOwner(key, owned)) continue;
      byOrg.set(key, [...(byOrg.get(key) ?? []), repo]);
    }
    for (const [key, repos] of [...byOrg.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const org = repos[0]!.owner.trim();
      let installationId: string | null;
      try {
        installationId = await findProvisioningInstallationId(org);
      } catch (err) {
        if (!isGithubFailure(err)) throw err;
        throw new FleetOrgCiGithubWriteError(key, statusOf(err), 'read');
      }
      if (installationId === null) continue;
      const orgTarget: GithubOrgTarget = { org, installationId, role: 'provisioning' };
      let hasPrivate = false;
      for (const repo of repos) {
        try {
          if (await repoVisibilityClient.isPrivate(repo.owner, repo.name, orgTarget)) {
            hasPrivate = true;
            break;
          }
        } catch (err) {
          if (!isGithubFailure(err)) throw err;
          throw new FleetOrgCiGithubWriteError(key, statusOf(err), 'read');
        }
      }
      if (!hasPrivate) continue;
      targets.push({
        projectId: project.id,
        projectKey: project.identifier,
        workspaceId: project.workspaceId,
        organizationId: project.organizationId,
        org,
        installationId,
      });
    }
  }
  return targets;
}

async function resolveTarget(pair: FleetOrgCiPair): Promise<FleetOrgCiTargetDTO> {
  const key = pair.org.trim().toLowerCase();
  // Refused before any GitHub call: an org Motir owns is never offered.
  if (!key || isMotirHostedOwner(key, await motirOwnedOrgLogins()))
    throw new FleetOrgCiTargetUnknownError(pair.projectId, key);
  const found = (await offeredTargets()).find(
    (t) => t.projectId === pair.projectId && t.org.toLowerCase() === key,
  );
  if (!found) throw new FleetOrgCiTargetUnknownError(pair.projectId, key);
  return found;
}

async function storedState(target: FleetOrgCiTargetDTO): Promise<FleetOrgCiStoredStateDTO> {
  const row = await platformFleetOrgCiRepository.find(target.projectId, target.org.toLowerCase());
  const updater = row?.updatedByUserId
    ? ((await userRepository.findByIds([row.updatedByUserId]))[0] ?? null)
    : null;
  return toFleetOrgCiStoredStateDTO(row, updater);
}

/** Undo what a failed flip moved on GitHub: the variable, then every default
 *  setup. What cannot be put back is logged with the pair — never the token. */
async function compensate(
  target: FleetOrgCiTargetDTO,
  previous: OrgVariable | null,
  moved: DefaultSetupMove[],
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await restoreVariable(previous, orgTargetFor(target));
  } catch (restoreErr) {
    console.error(
      `${LOG} GitHub and the stored state now disagree: the flip's commit failed and the variable could not be restored`,
      { ...context, restoreStatus: statusOf(restoreErr) },
    );
  }
  const unrestored = await restoreDefaultSetups(target, moved);
  if (unrestored.length > 0) {
    console.error(
      `${LOG} GitHub and the stored state now disagree: the flip failed and these CodeQL default setups could not be put back`,
      { ...context, repositories: unrestored },
    );
  }
}

/** Put the variable back to what it was before a flip whose commit failed. */
async function restoreVariable(
  previous: OrgVariable | null,
  target: GithubOrgTarget,
): Promise<void> {
  if (previous) {
    await actionsVariableClient.ensureOrgVariable(MOTIR_RUNNER_VARIABLE, previous.value, target);
  } else {
    await actionsVariableClient.deleteOrgVariable(MOTIR_RUNNER_VARIABLE, target);
  }
}

/** One private repository of a pair. */
interface PairRepo {
  owner: string;
  name: string;
}

/** A default-setup runner move the flip makes on one repository. */
interface DefaultSetupMove {
  repo: PairRepo;
  from: DefaultSetupRunner;
  to: DefaultSetupRunner;
}

const FLEET_RUNNER: DefaultSetupRunner = { type: 'labeled', label: MOTIR_RUNNER_LABEL };
const HOSTED_RUNNER: DefaultSetupRunner = { type: 'standard' };

/** The flip transaction's fixed work: the chain lock, the row lock and re-read,
 *  the upsert and the hash-chained audit append — plus room to wait on another
 *  platform transaction's chain lock. */
export const FLIP_TRANSACTION_BASE_MS = 10_000;
/** One GitHub request's share of the deadline. GitHub answers a variable or
 *  default-setup write well inside a second; this leaves room for a slow one. */
export const FLIP_GITHUB_REQUEST_BUDGET_MS = 5_000;
/** `ensureOrgVariable` reads, then creates or patches, and a lost create race
 *  patches again: three requests at most. `deleteOrgVariable` is one. */
const VARIABLE_WRITE_REQUESTS = 3;

/** The flip transaction's deadline: its fixed work plus every GitHub request it
 *  makes while it holds the locks — the variable write and one PATCH per move. */
export function flipTransactionTimeoutMs(moveCount: number): number {
  return (
    FLIP_TRANSACTION_BASE_MS +
    FLIP_GITHUB_REQUEST_BUDGET_MS * (VARIABLE_WRITE_REQUESTS + Math.max(0, moveCount))
  );
}

const direction = (enabled: boolean): 'fleet' | 'github_hosted' =>
  enabled ? 'fleet' : 'github_hosted';

/**
 * The pair's PRIVATE repositories on its org, in name order — the set the
 * default-setup move considers. A GitHub failure reading visibility throws
 * `FleetOrgCiGithubWriteError` (`read`), as `offeredTargets` does.
 */
async function privateReposOf(target: FleetOrgCiTargetDTO): Promise<PairRepo[]> {
  const key = target.org.toLowerCase();
  const realized = await withWorkspaceServiceContext(target.workspaceId, (tx) =>
    projectRepoRepository.listEstablishedRealizedRepos(target.projectId, target.workspaceId, tx),
  );
  const repos: PairRepo[] = [];
  for (const repo of realized) {
    if (repo.owner.trim().toLowerCase() !== key) continue;
    try {
      if (await repoVisibilityClient.isPrivate(repo.owner, repo.name, orgTargetFor(target))) {
        repos.push({ owner: repo.owner, name: repo.name });
      }
    } catch (err) {
      if (!isGithubFailure(err)) throw err;
      throw new FleetOrgCiGithubWriteError(key, statusOf(err), 'read');
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/** Each repository's default setup, read for the flip. A failed read refuses it. */
async function readDefaultSetups(
  target: FleetOrgCiTargetDTO,
  repos: PairRepo[],
  enabled: boolean,
): Promise<Array<{ repo: PairRepo; setup: DefaultSetup }>> {
  const reads: Array<{ repo: PairRepo; setup: DefaultSetup }> = [];
  for (const repo of repos) {
    try {
      const setup = await codeScanningDefaultSetupClient.get(
        repo.owner,
        repo.name,
        orgTargetFor(target),
      );
      reads.push({ repo, setup });
    } catch (err) {
      if (!isGithubFailure(err)) throw err;
      throw new FleetOrgCiCodeScanningError(
        target.org.toLowerCase(),
        repo.name,
        statusOf(err),
        'read',
        direction(enabled),
      );
    }
  }
  return reads;
}

/** The moves a flip to `enabled` makes: configured repositories not yet where
 *  the flip wants them. ON moves any other runner onto the fleet label; OFF moves
 *  only a repository on the fleet label (another label is not the fleet's). */
export function plannedDefaultSetupMoves(
  reads: Array<{ repo: PairRepo; setup: DefaultSetup }>,
  enabled: boolean,
): DefaultSetupMove[] {
  const moves: DefaultSetupMove[] = [];
  for (const { repo, setup } of reads) {
    if (setup.state !== 'configured') continue;
    const onFleet = runnerRequests(setup.runner, MOTIR_RUNNER_LABEL);
    if (enabled === onFleet) continue;
    moves.push({ repo, from: setup.runner, to: enabled ? FLEET_RUNNER : HOSTED_RUNNER });
  }
  return moves;
}

/** Make each move, recording it in `moved` as it lands so a later failure can
 *  put it back. A GitHub refusal throws `FleetOrgCiCodeScanningError` (`write`). */
async function applyDefaultSetupMoves(
  target: FleetOrgCiTargetDTO,
  moves: DefaultSetupMove[],
  moved: DefaultSetupMove[],
  enabled: boolean,
): Promise<void> {
  for (const move of moves) {
    try {
      await codeScanningDefaultSetupClient.setRunner(
        move.repo.owner,
        move.repo.name,
        move.to,
        orgTargetFor(target),
      );
    } catch (err) {
      if (!isGithubFailure(err)) throw err;
      throw new FleetOrgCiCodeScanningError(
        target.org.toLowerCase(),
        move.repo.name,
        statusOf(err),
        'write',
        direction(enabled),
      );
    }
    moved.push(move);
  }
}

/** Put back every default setup the failed flip had moved. Returns the names of
 *  the repositories that could not be put back. */
async function restoreDefaultSetups(
  target: FleetOrgCiTargetDTO,
  moved: DefaultSetupMove[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const move of moved) {
    try {
      await codeScanningDefaultSetupClient.setRunner(
        move.repo.owner,
        move.repo.name,
        move.from,
        orgTargetFor(target),
      );
    } catch {
      failed.push(move.repo.name);
    }
  }
  return failed;
}

/** One repository's default setup for the page; a failed read is `unknown`. */
async function codeScanningStateOf(
  target: FleetOrgCiTargetDTO,
  repo: PairRepo,
): Promise<FleetOrgCiCodeScanningDTO> {
  try {
    const setup = await codeScanningDefaultSetupClient.get(
      repo.owner,
      repo.name,
      orgTargetFor(target),
    );
    if (setup.state === 'unavailable') return { repo: repo.name, state: 'unavailable' };
    if (setup.state === 'not-configured') return { repo: repo.name, state: 'not_configured' };
    return {
      repo: repo.name,
      state: runnerRequests(setup.runner, MOTIR_RUNNER_LABEL) ? 'fleet' : 'github_hosted',
    };
  } catch (err) {
    if (!isGithubFailure(err)) throw err;
    return { repo: repo.name, state: 'unknown', status: statusOf(err) };
  }
}

export const fleetOrgCiSettingService = {
  /**
   * The same pairs, for a SYSTEM caller — the daily image-coverage probe
   * (MOTIR-10290), which runs with no principal. Read-only: it changes nothing
   * and returns what the console would offer a superadmin.
   *
   * @throws FleetOrgCiGithubWriteError when a repository's visibility cannot be read.
   */
  async systemTargets(): Promise<FleetOrgCiTargetDTO[]> {
    return offeredTargets();
  },

  /**
   * The pairs the console offers the switch for.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws FleetOrgCiGithubWriteError when a repository's visibility cannot be read.
   */
  async listTargets(principal: PlatformPrincipal): Promise<FleetOrgCiTargetDTO[]> {
    void principal;
    await requirePlatformStaff('superadmin');
    return offeredTargets();
  },

  /**
   * One pair's stored state, its readiness verdict, the variable read back
   * from GitHub and each private repository's CodeQL default-setup runner. Not audited: it reads no tenant row (the planner-model
   * `getSettings` reason) — the last flip's reason is kept on the row itself.
   *
   * @throws NotPlatformStaffError below `superadmin`, before any GitHub call.
   * @throws FleetOrgCiTargetUnknownError for a pair the console does not offer.
   */
  async getState(principal: PlatformPrincipal, pair: FleetOrgCiPair): Promise<FleetOrgCiStateDTO> {
    void principal;
    await requirePlatformStaff('superadmin');
    const target = await resolveTarget(pair);
    const [stored, readiness] = await Promise.all([
      storedState(target),
      fleetReadinessService.readinessFor({
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        org: target.org,
      }),
    ]);
    let variable: FleetOrgCiVariableDTO;
    try {
      const read = await actionsVariableClient.getOrgVariable(
        MOTIR_RUNNER_VARIABLE,
        orgTargetFor(target),
      );
      variable = read
        ? { state: 'present', value: read.value, visibility: read.visibility }
        : { state: 'absent' };
    } catch (err) {
      if (!isGithubFailure(err)) throw err;
      variable = { state: 'unknown', status: statusOf(err) };
    }
    const repos = await privateReposOf(target);
    const codeScanning = await Promise.all(repos.map((repo) => codeScanningStateOf(target, repo)));
    return { ...stored, readiness, variable, codeScanning };
  },

  /**
   * Turn the fleet ON or OFF for one pair. The ORDER is the contract:
   *
   *   1. `superadmin`, before any remote call.
   *   2. The pair must be offered (`FleetOrgCiTargetUnknownError`).
   *   3. The REASON, before any transaction.
   *   4. The stored state: already as asked ⇒ `unchanged`, nothing written.
   *   5. ON only: the readiness verdict. OFF never reads it.
   *   6. The variable and each private repository's CodeQL default setup as
   *      they are, kept for compensation.
   *   7. The audited transaction: lock, re-read, the variable write, the
   *      default-setup moves, upsert, audit row — under a deadline sized to the
   *      GitHub writes it makes ({@link flipTransactionTimeoutMs}).
   *   8. A failure after GitHub wrote ⇒ restore the variable and every default
   *      setup read in step 6.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws FleetOrgCiTargetUnknownError for a pair the console does not offer.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws FleetOrgCiNotReadyError when turning ON a pair that is not ready.
   * @throws FleetOrgCiGithubWriteError when GitHub refuses or cannot be reached.
   * @throws FleetOrgCiCodeScanningError when a repository's CodeQL default setup
   *         cannot be read or moved.
   */
  async setEnabled(
    principal: PlatformPrincipal,
    pair: FleetOrgCiPair,
    enabled: boolean,
    reason: string,
  ): Promise<FleetOrgCiFlipDTO> {
    await requirePlatformStaff('superadmin');
    const target = await resolveTarget(pair);
    const org = target.org.toLowerCase();
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    const base = {
      action: enabled ? ('fleet.org_ci.enable' as const) : ('fleet.org_ci.disable' as const),
      targetKind: 'platform' as const,
      targetId: `${target.projectId}:${org}`,
      targetLabel: `${target.projectKey} · ${org}`,
      organizationId: target.organizationId,
      reason: trimmed,
    };
    assertReasonSatisfied(base);

    const before = await storedState(target);
    if (before.enabled === enabled) return { outcome: 'unchanged', state: before };

    if (enabled) {
      const readiness = await fleetReadinessService.readinessFor({
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        org: target.org,
      });
      if (!readiness.ready) {
        throw new FleetOrgCiNotReadyError(
          target.projectId,
          org,
          readiness.conditions
            .filter((c) => c.state !== 'met')
            .map((c) => ({
              key: c.key,
              state: c.state as 'unmet' | 'unknown',
              reasonCode: c.reasonCode,
              message: c.message,
            })),
        );
      }
    }

    const ghTarget = orgTargetFor(target);
    let previous: OrgVariable | null;
    try {
      previous = await actionsVariableClient.getOrgVariable(MOTIR_RUNNER_VARIABLE, ghTarget);
    } catch (err) {
      if (!isGithubFailure(err)) throw err;
      throw new FleetOrgCiGithubWriteError(org, statusOf(err), 'read');
    }
    const moves = plannedDefaultSetupMoves(
      await readDefaultSetups(target, await privateReposOf(target), enabled),
      enabled,
    );
    const moved: DefaultSetupMove[] = [];

    const operation = enabled ? 'set' : 'delete';
    let applied = false;
    try {
      await withPlatformWrite(
        principal,
        async (tx, record) => {
          const locked = await platformFleetOrgCiRepository.lockForUpdate(
            target.projectId,
            org,
            tx,
          );
          if ((locked?.enabled ?? false) === enabled) throw new UnchangedUnderLock();

          let variableOutcome: string;
          try {
            variableOutcome = enabled
              ? await actionsVariableClient.ensureOrgVariable(
                  MOTIR_RUNNER_VARIABLE,
                  MOTIR_RUNNER_LABEL,
                  ghTarget,
                )
              : await actionsVariableClient.deleteOrgVariable(MOTIR_RUNNER_VARIABLE, ghTarget);
          } catch (err) {
            if (!isGithubFailure(err)) throw err;
            throw new FleetOrgCiGithubWriteError(org, statusOf(err), operation);
          }
          applied = true;
          await applyDefaultSetupMoves(target, moves, moved, enabled);

          await platformFleetOrgCiRepository.upsert(
            {
              projectId: target.projectId,
              org,
              enabled,
              lastReason: trimmed,
              updatedByUserId: principal.userId,
            },
            tx,
          );
          const entry: PlatformAuditEntry = {
            ...base,
            metadata: {
              projectId: target.projectId,
              projectKey: target.projectKey,
              org,
              from: !enabled,
              to: enabled,
              variableOutcome,
              codeScanningMoved: moved.map((m) => m.repo.name),
            },
          };
          await record(entry);
        },
        { timeoutMs: flipTransactionTimeoutMs(moves.length) },
      );
    } catch (err) {
      if (err instanceof UnchangedUnderLock) {
        return { outcome: 'unchanged', state: await storedState(target) };
      }
      if (applied) {
        // The residual case in this file's header: GitHub moved, core did not.
        await compensate(target, previous, moved, {
          projectId: target.projectId,
          org,
          from: !enabled,
          to: enabled,
          actorUserId: principal.userId,
        });
      }
      throw err;
    }
    return { outcome: 'changed', state: await storedState(target) };
  },
};
