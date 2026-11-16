import type { Prisma } from '@/generated/prisma/client';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRunnerGroupRepository } from '@/lib/repositories/projectRunnerGroupRepository';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import {
  findProvisioningInstallationId,
  isRepoProvisioningConfigured,
} from '@/lib/github/repoProvisioning';
import { runnerGroupClient, runnerGroupNameFor } from '@/lib/github/runnerGroups';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { repoVisibilityClient } from '@/lib/github/repoVisibility';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';

// The PER-PROJECT RUNNER GROUP (Story MOTIR-1916 · MOTIR-1972) — the service that
// keeps "one GitHub Actions runner group per Motir PROJECT, access-listed to
// exactly that project's repositories" true, from the first repository the
// project establishes to the handoff that takes them all away.
//
// ⚠️ THIS IS CORRECTNESS, NOT ISOLATION HYGIENE — `docs/decisions/ci-runner-fleet.md`
// §7.3. `runs-on` resolves to a STATIC label (`vars.MOTIR_RUNNER`), so every
// fleet runner visible to a queued fleet job matches it. With one org-wide group
// a runner Motir booted for project X is picked up by project Y's queued job —
// including a job MOTIR-1922's admission gate DECLINED. The gate becomes
// advisory: a tenant at its cap, or at `ci_credits_exhausted`, still gets CI,
// paid for by another tenant's provisioning decision and metered to the wrong
// org. The group's `selected_repository_ids` is what makes the label
// unambiguous, which is why {@link projectRunnerGroupService.requireRunnerGroupId}
// REFUSES rather than falling back to the `Default` group (id 1, `visibility:
// all`).
//
// ⚠️ THE ACCESS LIST IS READ-DERIVED, SO THE PROJECT ROW IS LOCKED ACROSS THE
// SYNC. `PUT …/repositories` replaces the WHOLE array, and the array is computed
// from the project's current repository set. Two rows establishing concurrently
// would each read the pre-existing set and the second write would ERASE the
// first's repository — a silent, permanent loss of CI for a repo that looks
// established. So the sync takes the project row's `FOR UPDATE` lock, re-reads
// inside the same transaction, and holds it until the write lands (the
// lock-before-read-derived-update rule).
//
// That means a transaction spanning HTTP calls, which is normally a smell, so the
// trade is stated rather than hidden: the alternative — release the lock, call
// GitHub, re-acquire — is a compare-and-set loop that has to re-read and retry
// anyway, and it converges no faster while being materially harder to reason
// about. The lock is per PROJECT (never global), establishment is a rare
// per-project event rather than a hot path, and the budget is raised explicitly
// ({@link SYNC_TX_BUDGET}) instead of inheriting Prisma's 5s default and failing
// under a slow GitHub.
//
// ⚠️ IT IS A SIDE EFFECT, AND IT NEVER FAILS AN ESTABLISHMENT. A created
// repository is a real artifact that cannot be rolled back (ADR §4.2), so a
// GitHub-side failure here records `runnerGroupSyncPending` and returns — the row
// stays established, the request still succeeds, and the next establish / removal
// pass re-syncs. `syncQuietly` is that contract made un-forgettable at the call
// sites.
//
// ⚠️ EVERY LOG LINE IS A CONSTANT MESSAGE + A STRUCTURED CONTEXT OBJECT, never a
// template literal carrying an id. `console.*`'s first argument is a FORMAT
// string (Node honours `%s` / `%d` / `%o`), so interpolating a request-derived
// value into it and then passing a second argument is CodeQL's
// `js/tainted-format-string`: an id containing `%s` would swallow the argument
// after it and silently corrupt the log. The structured form is also what the
// sibling fleet service (`ciRunnerProvisioningService`) already uses.
//
// ⚠️ NO ACCESS GATE OF ITS OWN, BY DESIGN. Every caller is either already
// edit-gated (the establish flow, `removeRow`) or is a webhook saga with no
// acting user at all (the transfer). So this service binds the workspace context
// directly — `withWorkspaceServiceContext`, the same tier the CI meter and the
// takeover webhook use — and takes the workspace id from the row it is acting on,
// never from input.
//
// ⚠️ A PROJECT'S GROUPS ARE A SET KEYED BY ORG (Story MOTIR-8699 · MOTIR-8712), and
// the provisioning org is its degenerate case. That group stays on the four
// `Project.runnerGroup*` columns, reached by the exact code path it always had,
// with no target. Every OTHER org that owns some of the project's established
// repositories AND has the provisioning App installed gets one group IN THAT ORG,
// access-listed to the project's PRIVATE repositories there, kept in
// `project_runner_group` and managed through that installation
// (`GithubOrgTarget`). An org without the App — every tenant's connected org
// today — is `skipped_no_install` and costs no write. Each connected org fails
// alone: its row is marked pending, and neither the provisioning pass nor another
// org is affected. Nothing here names an org; who is served is decided by where
// the App is installed.

/**
 * The raised transaction budget for a sync. 30s is comfortably past the three
 * GitHub round-trips a worst-case sync makes (installation + token are cached,
 * then read-or-find, then the access-list PUT) while still bounded: a GitHub
 * outage releases the project's lock in half a minute rather than holding it
 * until the connection dies.
 */
const SYNC_TX_BUDGET = { timeoutMs: 30_000, maxWaitMs: 10_000 } as const;

/** Whom a sync is for. Both ids come from a row the caller already resolved. */
export interface ProjectRunnerGroupTarget {
  projectId: string;
  workspaceId: string;
}

/** What the connected-org pass did for ONE org (MOTIR-8712). */
export interface ConnectedOrgSyncOutcome {
  org: string;
  outcome: 'synced' | 'sync_pending' | 'skipped_no_install' | 'deleted';
  runnerGroupId?: number;
  repositoryIds?: number[];
  created?: boolean;
  detail?: string;
}

/** What the connected-org pass of a delete did for ONE org. */
export interface ConnectedOrgDeleteOutcome {
  org: string;
  outcome: 'deleted' | 'delete_failed';
  runnerGroupId: number;
  detail?: string;
}

/** Options for {@link projectRunnerGroupService.syncForProject}. */
export interface RunnerGroupSyncOptions {
  /** Re-ask GitHub whether the App is installed on an org it was recently not
   *  installed on — the one-shot sync script. */
  bypassInstallationCache?: boolean;
  /**
   * The tenant's ASSIGNED Motir-owned GitHub org (MOTIR-8966), passed by the
   * establish flow before the first repository exists. When it names an org other
   * than the provisioning org, the project's group is ensured THERE (adopt by
   * name, else create with an empty access list) and stored in
   * `project_runner_group` as the connected-org pass stores it; and no group is
   * made in the provisioning org for a project that has no repositories there.
   */
  hostedOrg?: GithubOrgTarget;
}

export type RunnerGroupSyncOutcome =
  /** This deployment never provisions repositories (self-hosted, or the Studio
   *  App / provisioning org is unwired), so there is no fleet, no group, and
   *  nothing to sync. A first-class state, not a misconfiguration. */
  (
    | { outcome: 'not_configured' }
    /** The project row is gone (deleted between the caller's read and this one). */
    | { outcome: 'unknown_project' }
    /** The group exists and its access list now matches the project's set. */
    | {
        outcome: 'synced';
        runnerGroupId: number;
        /** TRUE when this call brought the group into existence — either by
         *  creating it or by ADOPTING one that a crashed earlier run had left. */
        created: boolean;
        repositoryIds: number[];
      }
    /** GitHub refused or was unreachable. The project is marked
     *  `runnerGroupSyncPending`; the caller's own work is unaffected. */
    | { outcome: 'sync_pending'; detail: string }
    /** The project is hosted in another Motir-owned GitHub org and has no
     *  repository and no group in the provisioning org, so none is made there
     *  (MOTIR-8966). */
    | { outcome: 'not_needed' }
  ) & {
    /** The connected-org pass, one entry per org other than the provisioning org
     *  that owns some of the project's repositories. ABSENT when there is none, so
     *  a provisioning-only project's outcome reads exactly as it always did. The
     *  top-level `outcome` keeps meaning the provisioning pass. */
    connectedOrgs?: ConnectedOrgSyncOutcome[];
  };

export type RunnerGroupDeleteOutcome = (
  | { outcome: 'not_configured' }
  | { outcome: 'unknown_project' }
  /** The project had no group to delete — already deleted, or never made. */
  | { outcome: 'no_group' }
  | { outcome: 'deleted'; runnerGroupId: number }
  /** GitHub refused. The columns are LEFT AS THEY ARE so a retry can find the
   *  group again — clearing them would orphan it beyond reach. */
  | { outcome: 'delete_failed'; runnerGroupId: number; detail: string }
) & {
  /** The connected-org groups this delete removed or failed to — absent when the
   *  project had none. */
  connectedOrgs?: ConnectedOrgDeleteOutcome[];
};

/**
 * The project has no runner group, so no ephemeral runner may be provisioned for
 * it — MOTIR-1921's refusal, and the whole point of this card.
 *
 * Falling back to the `Default` group (id 1, `visibility: all`) would be the
 * org-wide group §7.3 forbids, silently restoring the cross-tenant pickup this
 * service exists to prevent. There is no lenient branch to take.
 */
export class RunnerGroupNotProvisionedError extends Error {
  readonly code = 'RUNNER_GROUP_NOT_PROVISIONED' as const;
  constructor(
    readonly projectId: string,
    /** The org the group was asked for (MOTIR-8712); null for the provisioning
     *  org's read through {@link projectRunnerGroupService.requireRunnerGroupId}. */
    readonly org: string | null = null,
  ) {
    super(
      `Project ${projectId} has no runner group${org ? ` in ${org}` : ''}, so no ephemeral runner can be provisioned for it.`,
    );
    this.name = 'RunnerGroupNotProvisionedError';
  }
}

export const projectRunnerGroupService = {
  /**
   * Make GitHub agree with this project's repository set: ensure the group
   * exists, then set its access list to exactly the project's ESTABLISHED
   * repositories in Motir's org.
   *
   * IDEMPOTENT AND SELF-HEALING, in that order of preference:
   *   1. the persisted id, if GitHub still has that group;
   *   2. otherwise a group with the deterministic NAME — the adopt path, which is
   *      what stops a run that created the group and crashed before persisting it
   *      from making a SECOND group on retry;
   *   3. otherwise create it.
   * A group deleted out of band therefore comes back, with its new id persisted.
   *
   * Called at the START of an establish run (so the group exists BEFORE the first
   * repository's Actions can queue a job) and again after every row that settles,
   * because rows establish independently and asynchronously (ADR §4.1) — this is
   * per-row and re-entrant, never a one-shot at create time.
   */
  async syncForProject(
    target: ProjectRunnerGroupTarget,
    options: RunnerGroupSyncOptions = {},
  ): Promise<RunnerGroupSyncOutcome> {
    const org = provisioningOrgLogin();
    if (!org || !isRepoProvisioningConfigured()) return { outcome: 'not_configured' };
    // A sync that was not handed the tenant's assigned org reads it (MOTIR-8966).
    const assigned =
      options.hostedOrg ??
      (await fleetGithubOrgAssignmentService.hostedTargetForWorkspace(target.workspaceId));

    return withWorkspaceServiceContext(
      target.workspaceId,
      async (tx): Promise<RunnerGroupSyncOutcome> => {
        // LOCK FIRST, then re-read: everything below derives the array it writes
        // to GitHub from rows that a concurrent establish is also changing. The
        // re-read is what the lock is FOR — reading before it would be reading a
        // value another writer may still change.
        const project = (await projectRepository.lockById(target.projectId, tx))
          ? await projectRepository.findById(target.projectId, tx)
          : null;
        if (!project) return { outcome: 'unknown_project' as const };

        // The DESIRED access list: every established row's realized repository,
        // narrowed to Motir's own org. A `connected` row points at a repository
        // the USER owns — GitHub would refuse to put its id in a group belonging
        // to Motir's org, and refusing the whole PUT over one such row would
        // strand the rows that do belong. A repository transferred out by
        // MOTIR-711 falls out of this list by the same rule, with no special case:
        // its owner is no longer Motir's org.
        const realized = await projectRepoRepository.listEstablishedRealizedRepos(
          target.projectId,
          target.workspaceId,
          tx,
        );
        const repositoryIds = motirOwnedRepoIds(realized, org);

        // A project hosted in its tenant's ASSIGNED org (MOTIR-8966) gets no group
        // in the provisioning org until something of it lives there.
        const hostedOrg = assigned && !sameOrg(assigned.org, org) ? assigned : undefined;
        const provisioning: RunnerGroupSyncOutcome =
          hostedOrg && repositoryIds.length === 0 && project.runnerGroupId === null
            ? { outcome: 'not_needed' as const }
            : await syncProvisioningGroup(tx, target, project.runnerGroupId, repositoryIds);
        // The connected-org pass runs under the SAME lock, after the provisioning
        // pass and whatever it answered — a provisioning-side failure must not
        // strand another org's group, and the reverse.
        const connectedOrgs = await syncConnectedOrgGroups(tx, target, realized, org, {
          ...options,
          hostedOrg,
        });
        return connectedOrgs.length > 0 ? { ...provisioning, connectedOrgs } : provisioning;
      },
      SYNC_TX_BUDGET,
    );
  },

  /**
   * {@link syncForProject} as a SIDE EFFECT — the form every establish-path call
   * site uses.
   *
   * The sync is post-commit and best-effort by contract, and this is where that
   * contract is enforced rather than re-remembered: an unexpected throw (a lost
   * database race, a project deleted mid-flight) is logged and swallowed, because
   * failing an establishment over the group would report a settled row as failed
   * and destroy the one artifact that cannot be recreated.
   */
  async syncQuietly(
    target: ProjectRunnerGroupTarget,
    options: RunnerGroupSyncOptions = {},
  ): Promise<void> {
    try {
      await this.syncForProject(target, options);
    } catch (err) {
      console.error('[projectRunnerGroupService] could not sync the runner group', {
        projectId: target.projectId,
        err,
      });
    }
  },

  /**
   * Re-sync every project that holds this repository, after GitHub reports its
   * VISIBILITY changed — the `repository` webhook's `privatized` / `publicized`
   * actions (MOTIR-11426).
   *
   * A connected org's access list is derived from visibility AT SYNC TIME
   * ({@link syncConnectedOrgGroups}), and nothing else re-syncs when a repository
   * goes private after it was established. Without this a repository that started
   * public stays off its group for good: its fleet jobs ask for the fleet label,
   * no runner in a group that grants the repository exists, and they sit queued
   * until GitHub expires them, with no error anywhere. The reverse matters for
   * isolation: a repository made public must leave the group, because a fork's
   * pull request can run code on a self-hosted runner.
   *
   * Each project goes through the SAME locked {@link syncForProject} the establish
   * path uses, one after another and never nested, so it takes that project's row
   * lock exactly as every other writer does. Best-effort per project, as every
   * webhook-driven sync is: one project's failure is logged and the next one is
   * still synced. `projects` is how many projects hold the repository — zero for
   * a repository no project has established, which is not an error.
   */
  async syncForRepositoryVisibilityChange(providerRepoId: string): Promise<{ projects: number }> {
    const targets = await withSystemContext((tx) =>
      projectRepoRepository.listProjectsByRealizedProviderRepoId(providerRepoId, tx),
    );
    for (const target of targets) await this.syncQuietly(target);
    return { projects: targets.length };
  },

  /**
   * THE CONSUMER READ (MOTIR-1921). The group id a JIT config is minted against,
   * or {@link RunnerGroupNotProvisionedError}.
   *
   * It THROWS rather than returning null on purpose: a nullable return invites the
   * `?? DEFAULT_GROUP_ID` that §7.3 forbids, and the failure this card exists to
   * prevent is exactly the one that a lenient default reintroduces silently. A
   * project with no group has no runner; that is a visible refusal, not a fallback.
   */
  async requireRunnerGroupId(target: ProjectRunnerGroupTarget): Promise<number> {
    const project = await withWorkspaceServiceContext(target.workspaceId, (tx) =>
      projectRepository.findById(target.projectId, tx),
    );
    const id = project?.runnerGroupId ?? null;
    if (id === null) throw new RunnerGroupNotProvisionedError(target.projectId);
    return id;
  },

  /**
   * THE CONSUMER READ for a job in ANY org (MOTIR-8712) — the boot path passes the
   * job repository's owner. The provisioning org reads the `Project` column, so it
   * equals {@link requireRunnerGroupId}; any other org reads its
   * `project_runner_group` row. No row, or a pending one with no group, throws
   * {@link RunnerGroupNotProvisionedError} naming the org — never a `Default`
   * group.
   */
  async requireRunnerGroupIdFor(target: ProjectRunnerGroupTarget, org: string): Promise<number> {
    const provisioning = provisioningOrgLogin();
    const wanted = org.trim().toLowerCase();
    if (provisioning !== null && provisioning.trim().toLowerCase() === wanted) {
      const project = await withWorkspaceServiceContext(target.workspaceId, (tx) =>
        projectRepository.findById(target.projectId, tx),
      );
      const id = project?.runnerGroupId ?? null;
      if (id === null) throw new RunnerGroupNotProvisionedError(target.projectId, org);
      return id;
    }
    const row = await withWorkspaceServiceContext(target.workspaceId, (tx) =>
      projectRunnerGroupRepository.findForOrg(target.projectId, wanted, tx),
    );
    if (!row) throw new RunnerGroupNotProvisionedError(target.projectId, org);
    return row.runnerGroupId;
  },

  /**
   * The stored group for one connected org, or null — the READINESS read
   * (MOTIR-8713). It reads the row only and makes no GitHub request.
   */
  async readForOrg(
    target: ProjectRunnerGroupTarget,
    org: string,
  ): Promise<{
    runnerGroupId: number;
    runnerGroupName: string;
    syncedAt: Date | null;
    syncPending: boolean;
  } | null> {
    const row = await withWorkspaceServiceContext(target.workspaceId, (tx) =>
      projectRunnerGroupRepository.findForOrg(target.projectId, org.trim().toLowerCase(), tx),
    );
    if (!row) return null;
    return {
      runnerGroupId: row.runnerGroupId,
      runnerGroupName: row.runnerGroupName,
      syncedAt: row.syncedAt,
      syncPending: row.syncPending,
    };
  },

  /**
   * Delete the project's group and clear its columns — the HANDOFF and
   * project-deletion path.
   *
   * An abandoned group is not billable, but it is an access list naming
   * repositories Motir no longer owns, which is the kind of stale grant that is
   * only ever discovered by an incident. Idempotent against an already-deleted
   * group (the client treats GitHub's 404 as the desired end state), so a retried
   * saga step is harmless.
   *
   * On a GitHub refusal the columns are LEFT ALONE: clearing them would leave a
   * live group in Motir's org with nothing pointing at it, which is strictly worse
   * than a delete that can be retried.
   */
  async deleteForProject(target: ProjectRunnerGroupTarget): Promise<RunnerGroupDeleteOutcome> {
    // Every group the project holds — the provisioning org's and each connected
    // org's (MOTIR-8712) — because project deletion leaves nothing to serve.
    return deleteGroups(target, { includeConnectedOrgs: true });
  },

  /**
   * The HANDOFF form: re-sync, and DELETE the group once the project has no
   * Motir-owned repositories left.
   *
   * MOTIR-711 transfers a project's repositories out of Motir's org one row at a
   * time, so each transfer drops that repository out of the access list and only
   * the LAST one empties it. Deleting on empty is therefore the honest end of the
   * handoff, and it is expressed as its own method rather than folded into
   * {@link syncForProject} for one reason: a sync's list is ALSO empty at the very
   * start of an establish run, before the first repository exists, and a
   * delete-on-empty rule inside the sync would destroy the group it had just made.
   */
  async syncAfterHandoff(target: ProjectRunnerGroupTarget): Promise<void> {
    try {
      const result = await this.syncForProject(target);
      if (result.outcome === 'synced' && result.repositoryIds.length === 0) {
        // The PROVISIONING group only (MOTIR-8712): a handoff empties Motir's
        // org, never a connected org's group, which the sync keeps in step itself.
        await deleteProvisioningGroup(target);
      }
    } catch (err) {
      console.error(
        '[projectRunnerGroupService] could not settle the runner group after a handoff',
        {
          projectId: target.projectId,
          err,
        },
      );
    }
  },

  /**
   * {@link deleteForProject} as a side effect, for the same reason
   * {@link syncQuietly} exists: a handoff that has already transferred the
   * repositories must not be reported as failed because the group could not be
   * tidied.
   */
  async deleteQuietly(target: ProjectRunnerGroupTarget): Promise<void> {
    try {
      await this.deleteForProject(target);
    } catch (err) {
      console.error('[projectRunnerGroupService] could not delete the runner group', {
        projectId: target.projectId,
        err,
      });
    }
  },
};

/**
 * Delete the project's provisioning-org group and clear its columns, and — with
 * `includeConnectedOrgs` — every connected-org group and its row. The shared body
 * of {@link projectRunnerGroupService.deleteForProject} (everything) and
 * {@link deleteProvisioningGroup} (the handoff: Motir's org only).
 */
async function deleteGroups(
  target: ProjectRunnerGroupTarget,
  options: { includeConnectedOrgs: boolean },
): Promise<RunnerGroupDeleteOutcome> {
  if (!isRepoProvisioningConfigured()) return { outcome: 'not_configured' };

  return withWorkspaceServiceContext(
    target.workspaceId,
    async (tx): Promise<RunnerGroupDeleteOutcome> => {
      const project = (await projectRepository.lockById(target.projectId, tx))
        ? await projectRepository.findById(target.projectId, tx)
        : null;
      if (!project) return { outcome: 'unknown_project' as const };
      const connectedOrgs = options.includeConnectedOrgs
        ? await deleteConnectedOrgGroups(tx, target)
        : [];
      const withConnected = <T extends object>(outcome: T) =>
        connectedOrgs.length > 0 ? { ...outcome, connectedOrgs } : outcome;
      const groupId = project.runnerGroupId;
      if (groupId === null) return withConnected({ outcome: 'no_group' as const });

      try {
        await runnerGroupClient.deleteGroup(groupId);
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'unknown';
        console.error(
          '[projectRunnerGroupService] could not delete the runner group — the columns are ' +
            'left in place so a retry can find it',
          { projectId: target.projectId, runnerGroupId: groupId, detail },
        );
        return withConnected({ outcome: 'delete_failed' as const, runnerGroupId: groupId, detail });
      }

      await projectRepository.setRunnerGroup(
        target.projectId,
        {
          runnerGroupId: null,
          runnerGroupName: null,
          runnerGroupSyncedAt: null,
          runnerGroupSyncPending: false,
        },
        tx,
      );
      return withConnected({ outcome: 'deleted' as const, runnerGroupId: groupId });
    },
    SYNC_TX_BUDGET,
  );
}

/** The HANDOFF's delete: the provisioning org's group only (MOTIR-8712). */
function deleteProvisioningGroup(
  target: ProjectRunnerGroupTarget,
): Promise<RunnerGroupDeleteOutcome> {
  return deleteGroups(target, { includeConnectedOrgs: false });
}

/**
 * The PROVISIONING org's pass — the shipped single-org sync, unchanged in effect:
 * no target on any call, the group on the `Project.runnerGroup*` columns.
 */
async function syncProvisioningGroup(
  tx: Prisma.TransactionClient,
  target: ProjectRunnerGroupTarget,
  persistedId: number | null,
  repositoryIds: number[],
): Promise<RunnerGroupSyncOutcome> {
  try {
    const existing = await resolveGroup(persistedId, target.projectId);
    if (existing) {
      await runnerGroupClient.setGroupRepositories(existing.id, repositoryIds);
      await projectRepository.setRunnerGroup(
        target.projectId,
        {
          runnerGroupId: existing.id,
          runnerGroupName: existing.name || runnerGroupNameFor(target.projectId),
          runnerGroupSyncedAt: new Date(),
          runnerGroupSyncPending: false,
        },
        tx,
      );
      return {
        outcome: 'synced' as const,
        runnerGroupId: existing.id,
        // An ADOPTED group is `created` from this project's point of view:
        // before this call the project had no usable group id.
        created: persistedId !== existing.id,
        repositoryIds,
      };
    }

    // Created WITH its access list, so there is never an instant where a
    // Motir group exists that grants nothing (or, worse, everything).
    const name = runnerGroupNameFor(target.projectId);
    const group = await runnerGroupClient.createGroup({
      name,
      selectedRepositoryIds: repositoryIds,
    });
    await projectRepository.setRunnerGroup(
      target.projectId,
      {
        runnerGroupId: group.id,
        runnerGroupName: group.name || name,
        runnerGroupSyncedAt: new Date(),
        runnerGroupSyncPending: false,
      },
      tx,
    );
    return {
      outcome: 'synced' as const,
      runnerGroupId: group.id,
      created: true,
      repositoryIds,
    };
  } catch (err) {
    // DEGRADE, never fail the caller. The repositories are established and
    // real; the group is behind, which is recorded so it can be seen and
    // re-attempted. Writing the flag is a plain UPDATE on the row we already
    // hold the lock on, so it stays inside this transaction.
    const detail = err instanceof Error ? err.message : 'unknown';
    await projectRepository.setRunnerGroup(target.projectId, { runnerGroupSyncPending: true }, tx);
    console.error(
      '[projectRunnerGroupService] runner-group sync failed — the repositories are ' +
        'established and the group is marked unsynced',
      { projectId: target.projectId, detail },
    );
    return { outcome: 'sync_pending' as const, detail };
  }
}

/**
 * The group this project should be using, or null when one must be created.
 *
 * The persisted id wins when GitHub still has it. A 404 there is the
 * SELF-HEALING case — an operator deleted the group by hand — and falls through
 * to the by-name lookup and then to a create, so the project ends the sync with a
 * working group and the new id persisted.
 *
 * The by-name lookup runs whenever there is no usable persisted id, and it is the
 * idempotency guarantee the card asks for: without it, a run that created the
 * group on GitHub and died before its transaction committed would make a SECOND
 * group on every retry, each one access-listing live repositories.
 */
async function resolveGroup(
  persistedId: number | null,
  projectId: string,
  orgTarget?: GithubOrgTarget,
): Promise<{ id: number; name: string } | null> {
  if (persistedId !== null) {
    const found = await runnerGroupClient.getGroup(persistedId, orgTarget);
    if (found) return found;
  }
  return runnerGroupClient.findGroupByName(runnerGroupNameFor(projectId), orgTarget);
}

/**
 * The CONNECTED-ORG pass (MOTIR-8712): one group per org other than the
 * provisioning org that owns some of the project's established repositories and
 * has the provisioning App installed, access-listed to the project's PRIVATE
 * repositories in that org, every call made through that org's target.
 *
 * Runs inside the caller's transaction and project lock. A failure in one org
 * marks only that org's row pending and is reported, never thrown.
 */
async function syncConnectedOrgGroups(
  tx: Prisma.TransactionClient,
  target: ProjectRunnerGroupTarget,
  realized: ReadonlyArray<{ owner: string; name: string; providerRepoId: string }>,
  provisioningOrg: string,
  options: RunnerGroupSyncOptions,
): Promise<ConnectedOrgSyncOutcome[]> {
  const byOrg = groupConnectedReposByOrg(realized, provisioningOrg);
  // The ASSIGNED org (MOTIR-8966) gets its group before its first repository
  // exists, so it is in the pass with whatever it holds — possibly nothing.
  const hostedKey = options.hostedOrg?.org.trim().toLowerCase();
  if (hostedKey && !byOrg.has(hostedKey)) byOrg.set(hostedKey, []);
  // Orgs that HAD a group but no longer own any of the project's repositories are
  // swept too, so a removed repository cannot leave a stale grant behind.
  for (const row of await projectRunnerGroupRepository.listForProject(
    target.projectId,
    target.workspaceId,
    tx,
  )) {
    if (!byOrg.has(row.org)) byOrg.set(row.org, []);
  }

  const outcomes: ConnectedOrgSyncOutcome[] = [];
  for (const [org, repos] of [...byOrg.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const stored = await projectRunnerGroupRepository.findForOrg(target.projectId, org, tx);
    try {
      const hosted = org === hostedKey ? options.hostedOrg : undefined;
      const installationId = stored?.installationId
        ? stored.installationId
        : hosted
          ? hosted.installationId
          : await findProvisioningInstallationId(org, {
              bypassNegativeCache: options.bypassInstallationCache,
            });
      if (installationId === null) {
        outcomes.push({ org, outcome: 'skipped_no_install' });
        continue;
      }
      const orgTarget: GithubOrgTarget = {
        org: hosted?.org ?? org,
        installationId,
        role: hosted?.role ?? 'provisioning',
      };

      const repositoryIds: number[] = [];
      for (const repo of repos) {
        const id = Number(repo.providerRepoId);
        if (!Number.isInteger(id) || id <= 0 || repositoryIds.includes(id)) continue;
        if (await repoVisibilityClient.isPrivate(repo.owner, repo.name, orgTarget)) {
          repositoryIds.push(id);
        }
      }

      // EMPTIED — the org no longer holds any private repository of this
      // project. Safe here and not in the provisioning pass: a connected
      // repository exists before it is connected, so an empty list is never
      // "the first repository has not been created yet".
      // The assigned org's group is the exception: it is MADE empty, before the
      // first repository exists, exactly as the provisioning org's group is.
      if (repositoryIds.length === 0 && !hosted) {
        if (stored) {
          await runnerGroupClient.deleteGroup(stored.runnerGroupId, orgTarget);
          await projectRunnerGroupRepository.deleteForOrg(target.projectId, org, tx);
          outcomes.push({ org, outcome: 'deleted', runnerGroupId: stored.runnerGroupId });
        }
        continue;
      }

      const name = runnerGroupNameFor(target.projectId);
      const existing = await resolveGroup(
        stored?.runnerGroupId ?? null,
        target.projectId,
        orgTarget,
      );
      let groupId: number;
      let groupName: string;
      if (existing) {
        await runnerGroupClient.setGroupRepositories(existing.id, repositoryIds, orgTarget);
        groupId = existing.id;
        groupName = existing.name || name;
      } else {
        const group = await runnerGroupClient.createGroup(
          { name, selectedRepositoryIds: repositoryIds },
          orgTarget,
        );
        groupId = group.id;
        groupName = group.name || name;
      }
      await projectRunnerGroupRepository.upsertForOrg(
        {
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          org,
          installationId,
          runnerGroupId: groupId,
          runnerGroupName: groupName,
          syncedAt: new Date(),
          syncPending: false,
        },
        tx,
      );
      outcomes.push({
        org,
        outcome: 'synced',
        runnerGroupId: groupId,
        repositoryIds,
        created: stored?.runnerGroupId !== groupId,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown';
      await projectRunnerGroupRepository.markPendingForOrg(target.projectId, org, tx);
      console.error(
        '[projectRunnerGroupService] connected-org runner-group sync failed — that org is ' +
          'marked unsynced',
        { projectId: target.projectId, org, detail },
      );
      outcomes.push({ org, outcome: 'sync_pending', detail });
    }
  }
  return outcomes;
}

/** GitHub logins compare case-insensitively. */
function sameOrg(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The project's established repositories outside the provisioning org, keyed by
 *  lower-cased owner. */
function groupConnectedReposByOrg(
  realized: ReadonlyArray<{ owner: string; name: string; providerRepoId: string }>,
  provisioningOrg: string,
): Map<string, Array<{ owner: string; name: string; providerRepoId: string }>> {
  const skip = provisioningOrg.trim().toLowerCase();
  const byOrg = new Map<string, Array<{ owner: string; name: string; providerRepoId: string }>>();
  for (const repo of realized) {
    const org = repo.owner.trim().toLowerCase();
    if (!org || org === skip) continue;
    const list = byOrg.get(org) ?? [];
    list.push(repo);
    byOrg.set(org, list);
  }
  return byOrg;
}

/** Delete every connected-org group of a project, each through its own org's
 *  target. A refused delete leaves that row so a retry can find the group. */
async function deleteConnectedOrgGroups(
  tx: Prisma.TransactionClient,
  target: ProjectRunnerGroupTarget,
): Promise<ConnectedOrgDeleteOutcome[]> {
  const outcomes: ConnectedOrgDeleteOutcome[] = [];
  for (const row of await projectRunnerGroupRepository.listForProject(
    target.projectId,
    target.workspaceId,
    tx,
  )) {
    const orgTarget: GithubOrgTarget = {
      org: row.org,
      installationId: row.installationId,
      role: 'provisioning',
    };
    try {
      await runnerGroupClient.deleteGroup(row.runnerGroupId, orgTarget);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown';
      console.error(
        '[projectRunnerGroupService] could not delete a connected-org runner group — its ' +
          'row is left in place so a retry can find it',
        { projectId: target.projectId, org: row.org, runnerGroupId: row.runnerGroupId, detail },
      );
      outcomes.push({
        org: row.org,
        outcome: 'delete_failed',
        runnerGroupId: row.runnerGroupId,
        detail,
      });
      continue;
    }
    await projectRunnerGroupRepository.deleteForOrg(target.projectId, row.org, tx);
    outcomes.push({ org: row.org, outcome: 'deleted', runnerGroupId: row.runnerGroupId });
  }
  return outcomes;
}

/**
 * The numeric GitHub repository ids of the rows Motir's org actually owns.
 *
 * Two filters, both load-bearing:
 *   * OWNER — only repositories in the provisioning org can be in a group that
 *     belongs to it. Compared case-INSENSITIVELY, because GitHub logins are, and
 *     the mirror echoes GitHub's casing while the env value is an operator's.
 *   * NUMERIC — `GithubRepo.repoId` is a string column shared with the GitLab
 *     provider, whose ids are not GitHub's. A non-numeric id is skipped rather
 *     than coerced to `NaN` and sent, which GitHub would reject for the whole
 *     array.
 * De-duplicated, because two set rows may not point at one repository today but
 * the array must be a set regardless of what the schema later allows.
 */
function motirOwnedRepoIds(
  realized: ReadonlyArray<{ owner: string; providerRepoId: string }>,
  org: string,
): number[] {
  const wanted = org.trim().toLowerCase();
  const ids = new Set<number>();
  for (const repo of realized) {
    if (repo.owner.trim().toLowerCase() !== wanted) continue;
    const id = Number(repo.providerRepoId);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}
