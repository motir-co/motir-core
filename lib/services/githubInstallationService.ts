import { assertWorkspaceOrgNotClosing } from '@/lib/organizations/closingGuard';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { assertOrgMember } from '@/lib/services/organizationAccessService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import type { JobCodeContext } from '@/lib/ai/codeContext';
import { githubInstallationOrgLinkRepository } from '@/lib/repositories/githubInstallationOrgLinkRepository';
import {
  InstallationNotAccessibleError,
  InstallationNotLinkableError,
  RepoSelectionRequiredError,
  RepositoryNotVisibleError,
  RepositoryOwnedByOtherOrganizationError,
  type ConflictingRepository,
} from '@/lib/github/errors';
import { PRISMA_UNIQUE_VIOLATION } from '@/lib/prisma/uniqueViolation';
import { assertOrgNotClosing } from '@/lib/organizations/closingGuard';
import { assertOrgCapability } from '@/lib/services/organizationAccessService';
import { withOrgContext } from '@/lib/organizations/context';
import { OrgForbiddenError } from '@/lib/organizations/errors';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import {
  userInstallationsClient,
  type GithubUserInstallation,
} from '@/lib/github/userInstallations';
import {
  encodeInstallState,
  type InstallReturnContext,
  type InstallState,
} from '@/lib/github/installState';
import { workspacesService } from '@/lib/services/workspacesService';
import { NotAMemberError } from '@/lib/workspaces/errors';
import { githubAppInstallUrl } from '@/lib/github/appLinks';
import type {
  GithubAccountForOrganizationDTO,
  GithubAccountRepositoriesDTO,
  GithubAccountsForOrganizationDTO,
} from '@/lib/dto/github';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { toGithubInstallationDTO } from '@/lib/mappers/githubMappers';
import { getGitProvider } from '@/lib/git';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import type { GithubInstallation, GithubRepo, Prisma } from '@/generated/prisma/client';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import type { GitProviderId, InstallationToken, NormalizedRepo } from '@/lib/git/types';

// GitHub App installation service (Story 7.10 · MOTIR-891) — "Grant 2". Owns the
// business logic + transactions for persisting an installation and its selected
// repos, reading a workspace's installation, and minting its short-lived access
// token THROUGH the GitProvider seam. The two grants are independent: this
// service never touches GithubIdentity, and a workspace with an installation but
// no member identity (or vice-versa) is a valid, crash-free state.
//
// Context by path (CLAUDE.md 4-layer + the RLS model):
//   * the WRITE path is the `installation` webhook (MOTIR-892), which has no
//     active workspace — it runs under `withSystemContext` (the trusted-writer
//     escape the RLS policy admits);
//   * the READ + token paths are tenant requests — they run under
//     `withWorkspaceContext`, so the workspace RLS gate scopes them.

/**
 * THE ONE PLACE an App install link is minted (MOTIR-8471). Every surface that
 * starts an install calls this, so what a link contains — the signed state, the
 * App URL — cannot change on one surface and be missed on another. Null when
 * the App slug is unset on this deployment.
 */
function mintInstallUrl(state: InstallState): string | null {
  return githubAppInstallUrl(encodeInstallState(state));
}

/**
 * The organisation's bound GitHub installation ROWS — the union of the rows
 * stamped with it and its `github_installation_org_link` rows, de-duplicated,
 * stamped first. Binds `app.organization_id` on `tx` so the org read arm
 * answers. The one place the union is written (MOTIR-8472 · MOTIR-8480).
 */
async function boundInstallationRows(
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<GithubInstallation[]> {
  await bindOrganizationContext(tx, organizationId);
  const stamped = await githubInstallationRepository.listByOrganizationId(organizationId, tx);
  const links = await githubInstallationOrgLinkRepository.listByOrganizationId(organizationId, tx);
  const seen = new Set<string>();
  const rows: GithubInstallation[] = [];
  for (const installation of [...stamped, ...links.map((link) => link.installation)]) {
    if (seen.has(installation.id)) continue;
    seen.add(installation.id);
    rows.push(installation);
  }
  return rows;
}

/** One of an organisation's connected repositories, as the migrate wizard and
 *  the planning envelope read it. */
export interface OrganizationRepoRow {
  repoRef: string;
  owner: string;
  name: string;
  provider: string;
  defaultBranch: string;
  installationRef: string;
  indexed: boolean;
}

/** A connected repository's index POINTER and size refusal — the facts the
 *  migrate wizard's per-repo index state is derived from (MOTIR-8768), keyed by
 *  ref. No ledger read: the caller resolves the pointer against its own. */
export interface OrganizationRepoIndexPointer {
  repoRef: string;
  indexingRunId: string | null;
  indexRefusedAt: Date | null;
}

/** The organisation's connected repositories, de-duplicated by `owner/name`, in
 *  installation then repository order — the half of
 *  {@link githubInstallationService.listOrganizationRepoRows} that reads no
 *  ledger, on the caller's transaction so a context without a user can run it. */
async function organizationGithubReposIn(
  workspaceId: string,
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<Array<{ repo: GithubRepo; installationRef: string }>> {
  // The workspace's OWN grant first, then the organisation's bound set. First
  // so the run's first repository — the ref the gate records — is the one
  // the workspace-tier read picked for the same world. Included at all so
  // the result is a superset of that read by construction, even for a
  // workspace grant whose row predates its organisation stamp.
  const own = await githubInstallationRepository.findByWorkspaceId(workspaceId, tx);
  const bound = await boundInstallationRows(organizationId, tx);
  const installations = own
    ? [own, ...bound.filter((installation) => installation.id !== own.id)]
    : bound;
  const seen = new Set<string>();
  const repos: Array<{ repo: GithubRepo; installationRef: string }> = [];
  for (const installation of installations) {
    const rows = await githubRepoRepository.listByInstallationAndOrg(
      installation.id,
      organizationId,
      tx,
    );
    for (const repo of rows) {
      const ref = `${repo.owner}/${repo.name}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      repos.push({ repo, installationRef: installation.installationId });
    }
  }
  return repos;
}

export const githubInstallationService = {
  /**
   * Persist an installation and reconcile its selected repos (WRITE path — the
   * webhook, system context). Input is already normalized through the provider
   * seam (`NormalizedRepo[]`). Upserts the installation, upserts each selected
   * repo, then deletes any repo no longer selected. Returns the token-free DTO.
   *
   * THE USER-INSTALLATION PATH ONLY (MOTIR-1931). `workspaceId` is a required
   * `string`, and a shared provisioning installation has none — so this method,
   * and with it the destructive `deleteExcept` prune, cannot be called for one.
   * That is deliberate: `fetchInstallationRepos` returns EVERY tenant's repos for
   * a shared installation, so a reconcile here would both delete the repos it did
   * not fetch and leak the ones it did. Motir-created repos are persisted one row
   * at a time by the creation primitive (MOTIR-1781), never reconciled.
   */
  async persistInstallation(input: {
    workspaceId: string;
    installation: { installationId: string; accountLogin: string; accountType: string };
    repos: NormalizedRepo[];
    /**
     * Whether a repository NO organisation owns yet is claimed (default `true`).
     * The webhook reconcile passes `false` when several organisations are linked
     * to the installation: a repository newly added on the account is then left
     * free for an admin to pick, never silently attached to every linked
     * organisation (MOTIR-8221). Repositories this organisation already owns are
     * kept either way.
     */
    claimFree?: boolean;
  }): Promise<GithubInstallationDTO> {
    const claimFree = input.claimFree ?? true;
    const { dto, prunedRefs, selectedRefs } = await withSystemContext(async (tx) => {
      // THE OWNING ORGANISATION (Story MOTIR-4669 · MOTIR-4649), resolved THROUGH
      // the workspace. `workspace.organizationId` is NOT NULL, so this read is
      // total for any workspace that exists — a missing workspace is a caller
      // error and throws rather than writing a null tenancy.
      const organizationId = await resolveOrganizationId(input.workspaceId, tx);
      // ⚠️ PER ORGANISATION since MOTIR-8219. One GitHub account's installation
      // can serve several organisations, so this reconcile must neither re-stamp
      // the installation's tenancy nor prune another organisation's rows: the
      // tenancy-preserving upsert, the per-organisation prune, and repositories
      // another organisation owns left exactly where they are. It has no chosen
      // set to refuse (it is the webhook's reconcile), so it skips them instead.
      const installation = await githubInstallationRepository.upsertPreservingTenancy(
        {
          installationId: input.installation.installationId,
          workspaceId: input.workspaceId,
          organizationId,
          accountLogin: input.installation.accountLogin,
          accountType: input.installation.accountType,
        },
        tx,
      );
      await githubInstallationRepository.lockByInstallationId(installation.installationId, tx);
      await githubInstallationOrgLinkRepository.upsert(
        { installationId: installation.id, organizationId, workspaceId: input.workspaceId },
        tx,
      );

      const conflicts = await conflictingRepositories(
        installation.provider,
        organizationId,
        input.repos,
        tx,
      );
      const ownedElsewhere = new Set(conflicts.map((repo) => repo.repoId));
      const ownedHere = claimFree
        ? null
        : new Set(
            (
              await githubRepoRepository.listByInstallationAndOrg(
                installation.id,
                organizationId,
                tx,
              )
            ).map((repo) => repo.repoId),
          );
      const claimable = input.repos.filter(
        (repo) =>
          !ownedElsewhere.has(repo.providerRepoId) &&
          (ownedHere === null || ownedHere.has(repo.providerRepoId)),
      );

      await upsertRepos(installation.id, input.workspaceId, organizationId, claimable, tx);
      // WHICH repos this reconcile DROPS (MOTIR-2166 ·
      // `docs/decisions/code-graph-index-fleet.md` §14.3) come back from the
      // delete itself, because a pruned row's `owner/name` — the `repoRef` the
      // offboarding queue is keyed by — is gone the moment it is deleted.
      const prunedRefs = await githubRepoRepository.deleteExceptForOrg(
        installation.id,
        organizationId,
        claimable.map((repo) => repo.providerRepoId),
        tx,
      );

      const repos = await githubRepoRepository.listByInstallationAndOrg(
        installation.id,
        organizationId,
        tx,
      );
      return {
        dto: toGithubInstallationDTO(installation, repos),
        prunedRefs,
        selectedRefs: repos.map((repo) => `${repo.owner}/${repo.name}`),
      };
    });

    // POST-COMMIT, BEST-EFFORT — the repo-disconnect arm of §14.3, reached from
    // the GitHub side. A repo dropped from the installation's SELECTION is a
    // disconnect: its `github_repo` row is gone, so nothing here will ever index
    // it again, and its derived graph must go with it after the window.
    await codeGraphOffboardingService.enqueueForRepos(
      input.workspaceId,
      prunedRefs,
      'repo_disconnected',
    );

    // …and the mirror: a repo that IS in the selection has a pending removal
    // called off. A reconcile is exactly how a user re-selects a repo they
    // de-selected earlier, which is the re-onboard §14.3 says must cancel the
    // window. Unconditional over the whole selection, because it is idempotent
    // and a no-op when nothing is pending — cheaper than tracking which of these
    // rows is new.
    await codeGraphOffboardingService.cancelForRepos(input.workspaceId, selectedRefs);

    return dto;
  },

  /**
   * LINK an installation to the workspace's organisation and CLAIM a chosen set
   * of its repositories (Story MOTIR-8216 · MOTIR-8219) — the one operation the
   * connect flow, the webhook routing and the disconnect are written against.
   *
   * One GitHub account has ONE installation of the App, and several Motir
   * organisations can now each be linked to it, each owning a disjoint subset
   * of its repositories. So this never re-stamps another organisation's
   * tenancy, never prunes another organisation's repositories, and refuses a
   * claim that names a repository another organisation owns — WHOLE, writing
   * nothing, with {@link RepositoryOwnedByOtherOrganizationError}.
   *
   * WHICH repositories, when `repoIds` is omitted: every visible one when no
   * other organisation is linked (the single-organisation behaviour the setup
   * flow has always had); the organisation's current subset when it is already
   * linked beside another (a refresh keeps its choice); and otherwise
   * {@link RepoSelectionRequiredError} — a new link beside another organisation
   * never silently takes everything.
   *
   * The GitHub reads happen BEFORE the transaction. Inside it the installation
   * row is locked, so two organisations claiming from one installation
   * serialise; the database's one-organisation-per-repository guard
   * (`trg_github_repo_one_organization`) is the backstop for a race through a
   * different installation, and its violation surfaces as the same typed error.
   * The CALLER authorises the acting user for `workspaceId`.
   */
  async linkInstallationToOrganization(ctx: {
    workspaceId: string;
    installationId: string;
    repoIds?: string[];
    provider?: GitProviderId;
  }): Promise<{ installation: GithubInstallationDTO; claimed: string[]; released: string[] }> {
    const gitProvider = getGitProvider(ctx.provider ?? 'github');
    const [account, visible] = await Promise.all([
      gitProvider.fetchInstallation(ctx.installationId),
      gitProvider.fetchInstallationRepos(ctx.installationId),
    ]);

    let result: {
      dto: GithubInstallationDTO;
      claimedRepos: NormalizedRepo[];
      keptRefs: string[];
      releasedRefs: string[];
    };
    try {
      result = await withSystemContext(async (tx) => {
        await assertWorkspaceOrgNotClosing(ctx.workspaceId, tx);
        const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);

        const installation = await githubInstallationRepository.upsertPreservingTenancy(
          {
            installationId: ctx.installationId,
            workspaceId: ctx.workspaceId,
            organizationId,
            accountLogin: account.accountLogin,
            accountType: account.accountType,
          },
          tx,
        );
        // Motir's shared provisioning installation (MOTIR-1931) belongs to no
        // tenant; its visible set spans every tenant's repositories.
        if (installation.workspaceId === null && installation.organizationId === null) {
          throw new InstallationNotLinkableError();
        }
        await githubInstallationRepository.lockByInstallationId(ctx.installationId, tx);

        const links = await githubInstallationOrgLinkRepository.listByInstallationId(
          installation.id,
          tx,
        );
        const alreadyLinked = links.some((link) => link.organizationId === organizationId);
        const othersLinked = links.some((link) => link.organizationId !== organizationId);
        await githubInstallationOrgLinkRepository.upsert(
          { installationId: installation.id, organizationId, workspaceId: ctx.workspaceId },
          tx,
        );

        const current = await githubRepoRepository.listByInstallationAndOrg(
          installation.id,
          organizationId,
          tx,
        );
        const visibleById = new Map(visible.map((repo) => [repo.providerRepoId, repo]));
        let chosenIds: string[];
        if (ctx.repoIds) {
          chosenIds = [...new Set(ctx.repoIds)];
        } else if (!othersLinked) {
          chosenIds = visible.map((repo) => repo.providerRepoId);
        } else if (alreadyLinked) {
          chosenIds = current.map((repo) => repo.repoId).filter((id) => visibleById.has(id));
        } else {
          throw new RepoSelectionRequiredError();
        }

        const notVisible = chosenIds.filter((id) => !visibleById.has(id));
        if (notVisible.length > 0) throw new RepositoryNotVisibleError(notVisible);
        const chosen = chosenIds.map((id) => visibleById.get(id)!);

        const conflicts = await conflictingRepositories(
          installation.provider,
          organizationId,
          chosen,
          tx,
        );
        if (conflicts.length > 0) throw new RepositoryOwnedByOtherOrganizationError(conflicts);

        const heldIds = new Set(current.map((repo) => repo.repoId));
        await upsertRepos(installation.id, ctx.workspaceId, organizationId, chosen, tx);
        const releasedRefs = await githubRepoRepository.deleteExceptForOrg(
          installation.id,
          organizationId,
          chosenIds,
          tx,
        );
        const repos = await githubRepoRepository.listByInstallationAndOrg(
          installation.id,
          organizationId,
          tx,
        );
        return {
          dto: toGithubInstallationDTO(installation, repos),
          claimedRepos: chosen.filter((repo) => !heldIds.has(repo.providerRepoId)),
          keptRefs: repos.map((repo) => `${repo.owner}/${repo.name}`),
          releasedRefs,
        };
      });
    } catch (err) {
      // A claim raced through ANOTHER installation lost at the database guard.
      // The transaction is gone, so re-read who owns what and refuse the same
      // way a conflict found up front is refused.
      if ((err as { code?: unknown }).code !== PRISMA_UNIQUE_VIOLATION) throw err;
      const conflicts = await withSystemContext(async (tx) => {
        const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
        const wanted = ctx.repoIds
          ? visible.filter((repo) => ctx.repoIds!.includes(repo.providerRepoId))
          : visible;
        return conflictingRepositories(ctx.provider ?? 'github', organizationId, wanted, tx);
      });
      if (conflicts.length === 0) throw err;
      throw new RepositoryOwnedByOtherOrganizationError(conflicts);
    }

    // POST-COMMIT, BEST-EFFORT, as `persistInstallation` does: released
    // repositories start their code-graph offboarding window, kept ones have a
    // pending removal called off, and the chosen set is offered for a first
    // index (gated on indexedness, so a repository already indexed is skipped).
    // Never fails the link.
    await codeGraphOffboardingService.enqueueForRepos(
      ctx.workspaceId,
      result.releasedRefs,
      'repo_disconnected',
    );
    await codeGraphOffboardingService.cancelForRepos(ctx.workspaceId, result.keptRefs);
    const chosenIds = new Set(result.dto.repos.map((repo) => repo.repoId));
    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: ctx.installationId,
      workspaceId: ctx.workspaceId,
      repos: visible.filter((repo) => chosenIds.has(repo.providerRepoId)),
    });

    return {
      installation: result.dto,
      claimed: result.claimedRepos.map((repo) => `${repo.owner}/${repo.name}`),
      released: result.releasedRefs,
    };
  },

  /**
   * THE ACCOUNTS AN ORGANISATION ADMIN CAN CONNECT (Story MOTIR-8216 ·
   * MOTIR-8220): every GitHub account the Motir App is installed on that the
   * ACTOR can see on GitHub, each marked `linked_here` or `not_linked` for this
   * organisation.
   *
   * ⚠️ THE LIST COMES FROM GITHUB (`GET /user/installations` with the actor's
   * own linked identity), never from `github_installation` rows. A row is
   * deleted when an account's last organisation disconnects, and an account
   * the actor can see is a fact about GitHub. Stored rows only decide the link
   * state and EXCLUDE Motir's shared provisioning installation. With no linked
   * identity the answer is `identity_required`, a state rather than an error.
   */
  async listAccountsForOrganization(ctx: {
    organizationId: string;
    actorUserId: string;
  }): Promise<GithubAccountsForOrganizationDTO> {
    await authoriseOrgAdmin(ctx.actorUserId, ctx.organizationId);
    const accounts = await accessibleInstallations(ctx.actorUserId);
    if (accounts === null) return { state: 'identity_required' };

    const linkable = await withSystemContext(async (tx) => {
      const out: { account: GithubUserInstallation; linkedHere: boolean }[] = [];
      for (const account of accounts) {
        const row = await githubInstallationRepository.findByInstallationId(
          account.installationId,
          tx,
        );
        if (row && isSharedProvisioningInstallation(row)) continue;
        const link = row
          ? await githubInstallationOrgLinkRepository.findByInstallationAndOrg(
              row.id,
              ctx.organizationId,
              tx,
            )
          : null;
        out.push({ account, linkedHere: link !== null });
      }
      return out;
    });

    const gitProvider = getGitProvider('github');
    const rows: GithubAccountForOrganizationDTO[] = await Promise.all(
      linkable.map(async ({ account, linkedHere }) => ({
        installationId: account.installationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
        avatarUrl: account.avatarUrl,
        // A count GitHub could not give is unknown, not zero.
        visibleRepoCount: await gitProvider
          .fetchInstallationRepos(account.installationId)
          .then((repos) => repos.length)
          .catch(() => null),
        linkState: linkedHere ? ('linked_here' as const) : ('not_linked' as const),
      })),
    );
    return { state: 'ok', accounts: rows };
  },

  /**
   * One account's repositories as THIS organisation may claim them (MOTIR-8220):
   * `available`, `connected_here`, or `connected_elsewhere`. The last carries no
   * identifier of the organisation, workspace or project that owns it.
   */
  async listRepositoriesForAccount(ctx: {
    organizationId: string;
    actorUserId: string;
    installationId: string;
  }): Promise<GithubAccountRepositoriesDTO> {
    await authoriseOrgAdmin(ctx.actorUserId, ctx.organizationId);
    await assertInstallationAccessible(ctx.actorUserId, ctx.installationId, 'picker');
    const visible = await getGitProvider('github').fetchInstallationRepos(ctx.installationId);
    const repos = await withSystemContext(async (tx) => {
      const out: GithubAccountRepositoriesDTO['repos'] = [];
      for (const repo of visible) {
        const owners = await githubRepoRepository.findByHostRepoId(
          'github',
          repo.providerRepoId,
          tx,
        );
        const availability =
          owners.length === 0
            ? ('available' as const)
            : owners.some((row) => row.organizationId !== ctx.organizationId)
              ? ('connected_elsewhere' as const)
              : ('connected_here' as const);
        out.push({
          repoId: repo.providerRepoId,
          fullName: `${repo.owner}/${repo.name}`,
          availability,
        });
      }
      return out;
    });
    return {
      repos,
      counts: {
        available: repos.filter((r) => r.availability === 'available').length,
        connectedHere: repos.filter((r) => r.availability === 'connected_here').length,
        connectedElsewhere: repos.filter((r) => r.availability === 'connected_elsewhere').length,
      },
    };
  },

  /**
   * THE ONE ENTRANCE that links an already-installed account to an organisation
   * (MOTIR-8220), used by BOTH the picker's POST and the install round trip, so
   * the two cannot diverge. Authorises the actor as an admin of the organisation
   * (and the organisation as not closing), checks the actor can see the
   * installation on GitHub, resolves which of the organisation's workspaces the
   * link is made from, and calls {@link linkInstallationToOrganization}.
   *
   * ⚠️ `via: 'install_return'` is the one relaxation, and it is bounded: an
   * actor with NO linked GitHub identity has just installed the App from
   * Motir's own signed link, and cannot be asked. That path omits `repoIds`, so
   * it can never take a repository from another organisation —
   * `linkInstallationToOrganization` refuses an omitted set beside another
   * linked organisation. The picker (`via: 'picker'`) has no such case: no
   * identity, no access.
   */
  async linkExistingInstallation(ctx: {
    organizationId: string;
    actorUserId: string;
    installationId: string;
    repoIds?: string[];
    via: 'picker' | 'install_return';
    /** The workspace the request came from — used when it belongs to the
     *  organisation; for the install round trip, the signed state's. */
    workspaceIdHint?: string;
    requireHintInOrganization?: boolean;
  }): Promise<{ installation: GithubInstallationDTO; claimed: string[]; released: string[] }> {
    await authoriseOrgAdmin(ctx.actorUserId, ctx.organizationId);
    await assertInstallationAccessible(ctx.actorUserId, ctx.installationId, ctx.via);
    const workspaceId = await workspaceForOrganization(
      ctx.organizationId,
      ctx.workspaceIdHint,
      ctx.requireHintInOrganization === true,
    );
    return this.linkInstallationToOrganization({
      workspaceId,
      installationId: ctx.installationId,
      ...(ctx.repoIds ? { repoIds: ctx.repoIds } : {}),
    });
  },

  /**
   * The signed install URL for "Install on another account" (MOTIR-8220): the
   * state names this organisation and returns to the Git room. Null when the
   * App is not configured on this deployment.
   */
  async installUrlForOrganization(ctx: {
    organizationId: string;
    actorUserId: string;
    workspaceIdHint?: string;
  }): Promise<string | null> {
    await authoriseOrgAdmin(ctx.actorUserId, ctx.organizationId);
    const workspaceId = await workspaceForOrganization(
      ctx.organizationId,
      ctx.workspaceIdHint,
      false,
    );
    return mintInstallUrl({
      workspaceId,
      userId: ctx.actorUserId,
      organizationId: ctx.organizationId,
      origin: 'organizationGit',
    });
  },

  /**
   * The signed install URL for a project Repositories room's `Connect a new one`
   * (Bug MOTIR-9828). The state names this organisation, so the callback takes
   * the ORG branch and refreshes the installation's repositories, and it names
   * the PROJECT and returns to its room, so the callback then links the
   * repositories this round trip connected into that project — the
   * "organisation connection AND the project link in one act" the picker
   * promises. Null when the App is not configured on this deployment.
   *
   * ORG-ADMIN, like `installUrlForOrganization`: connecting a repository to the
   * organisation and linking it into a project are both org-admin acts, and a
   * link is never minted for an actor the callback would refuse.
   */
  async installUrlForProjectRepositories(ctx: {
    organizationId: string;
    actorUserId: string;
    workspaceId: string;
    projectKey: string;
  }): Promise<string | null> {
    await authoriseOrgAdmin(ctx.actorUserId, ctx.organizationId);
    const workspaceId = await workspaceForOrganization(ctx.organizationId, ctx.workspaceId, true);
    return mintInstallUrl({
      workspaceId,
      userId: ctx.actorUserId,
      organizationId: ctx.organizationId,
      origin: 'projectRepositories',
      projectKey: ctx.projectKey,
    });
  },

  /**
   * The signed install URL the onboarding Connect step starts from (Story
   * MOTIR-8241 · MOTIR-8471): the state returns to `/onboarding/migrate` and
   * carries the step's own query (`context`, already narrowed by
   * `onboardingReturnContextFrom`). Null when the App is not configured.
   *
   * ⚠️ NO `organizationId`, deliberately. A state that names an organisation
   * takes the callback's ORG branch, which authorises an organisation ADMIN and
   * links an existing installation. Onboarding is first-time binding of the
   * workspace the person is in, so the callback must take the workspace branch,
   * whose predicate is membership — the same one asserted here, so a link is
   * never minted for a workspace the callback would refuse.
   */
  async installUrlForOnboardingConnect(ctx: {
    workspaceId: string;
    actorUserId: string;
    context?: InstallReturnContext;
  }): Promise<string | null> {
    const role = await workspacesService.getMemberRole(ctx.actorUserId, ctx.workspaceId);
    if (!role) throw new NotAMemberError(ctx.actorUserId, ctx.workspaceId);
    return mintInstallUrl({
      workspaceId: ctx.workspaceId,
      userId: ctx.actorUserId,
      origin: 'onboardingMigrateConnect',
      ...(ctx.context ? { context: ctx.context } : {}),
    });
  },

  /**
   * Mirror ONE repository Motir just CREATED in its provisioning org (Story
   * MOTIR-1775 · MOTIR-1781) — the whole write, and deliberately not a reconcile.
   *
   * Two facts make this a separate method rather than a `persistInstallation`
   * call with one repo:
   *
   *   1. **The installation is SHARED and belongs to no tenant** (MOTIR-1931 /
   *      the ADR's 2026-07-31 amendment §3). It is upserted with
   *      `workspaceId: null`; the REPO row carries the creating project's
   *      workspace, which is what every tenancy read now resolves through.
   *   2. **Nothing may prune.** `persistInstallation` reconciles the whole
   *      selection and would call `deleteExcept` — on a shared installation that
   *      deletes every OTHER tenant's created repos. This writes exactly the one
   *      row and touches nothing else, so `deleteExcept` stays unreachable on
   *      this path as a property of the code, not as a caution.
   *
   * There is also NO webhook to wait for: GitHub fires no
   * `installation_repositories` delivery for a repo the App itself creates on an
   * all-repositories install (spike Mechanic 2), which is exactly why the
   * creation flow drives this in-flow. Returns the mirrored row.
   *
   * System context — like every other installation write, this runs with no
   * active workspace (the acting caller's own workspace gates the row it is
   * about, one layer up, in `projectRepoProvisioningService`).
   */
  async persistProvisionedRepo(input: {
    /** The tenant the REPOSITORY belongs to — stamped on the repo row. */
    workspaceId: string;
    installation: { installationId: string; accountLogin: string; accountType: string };
    repo: NormalizedRepo;
  }): Promise<GithubRepo> {
    return withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.upsert(
        {
          installationId: input.installation.installationId,
          // NULL, always: Motir's provisioning installation serves N workspaces
          // and is owned by none of them.
          workspaceId: null,
          // NULL for the SAME reason, and this is the one row the column is
          // nullable FOR (MOTIR-4649). An installation shared across tenants can
          // name no organisation any more than it can name a workspace; the
          // repository rows below carry the tenancy, as they already did.
          organizationId: null,
          accountLogin: input.installation.accountLogin,
          accountType: input.installation.accountType,
        },
        tx,
      );
      // The REPOSITORY, by contrast, always has one — resolved through the
      // workspace it was created for.
      const organizationId = await resolveOrganizationId(input.workspaceId, tx);
      return githubRepoRepository.upsert(
        {
          installationId: installation.id,
          workspaceId: input.workspaceId,
          organizationId,
          repoId: input.repo.providerRepoId,
          owner: input.repo.owner,
          name: input.repo.name,
          defaultBranch: input.repo.defaultBranch,
          // A repository Motir just created is never archived, so this is
          // `false` in practice — recorded from the host's own value anyway
          // rather than assumed, so there is one rule for how the column is
          // filled and no path that hardcodes an answer (MOTIR-1959).
          archived: input.repo.archived,
        },
        tx,
      );
    });
  },

  /**
   * Apply a repository's ARCHIVED / UNARCHIVED state from the host (MOTIR-1959) —
   * the `repository` delivery's write, and the reason the recorded liveness stays
   * true instead of freezing at whatever it was when the row was mirrored.
   *
   * System context, like every other installation write: the webhook has no active
   * workspace. Idempotent by construction — the repository's `updateMany` makes a
   * redelivery a no-op, and re-applying the same value writes the same row.
   *
   * Returns whether any mirror row was touched. `false` is the ordinary answer for
   * a repository Motir does not mirror at all: the shared provisioning
   * installation sees deliveries for repositories belonging to no project row, and
   * that is not an error to raise.
   */
  async applyArchivedState(input: { providerRepoId: string; archived: boolean }): Promise<boolean> {
    return withSystemContext(async (tx) => {
      const count = await githubRepoRepository.setArchivedByRepoId(
        input.providerRepoId,
        input.archived,
        tx,
      );
      return count > 0;
    });
  },

  /**
   * BIND a fresh App installation to a workspace (MOTIR-1588) — the post-install
   * setup flow's landing. The webhook (MOTIR-892) only RECONCILES an
   * already-bound installation; this creates the first binding. Given only the
   * host `installationId` (from GitHub's post-install redirect), it fetches the
   * installation's account + selected repos through the provider seam (App JWT →
   * installation token) and upserts them for `workspaceId` via
   * `persistInstallation`. The CALLER (the setup route) is responsible for
   * authorizing that the acting user may bind to `workspaceId`. Idempotent — a
   * re-install / repo-selection change refreshes the same rows in place.
   */
  async bindInstallationForWorkspace(ctx: {
    workspaceId: string;
    installationId: string;
    provider?: GitProviderId;
  }): Promise<GithubInstallationDTO> {
    // No new connection in an org scheduled for deletion (MOTIR-6396). System
    // context: this door carries no user, and both rows have a system read arm.
    await withSystemContext((tx) => assertWorkspaceOrgNotClosing(ctx.workspaceId, tx));
    // Since MOTIR-8219 this is the per-organisation link: with no other
    // organisation linked it claims every visible repository exactly as it
    // always did, and it can no longer overwrite or prune another one's.
    const { installation } = await this.linkInstallationToOrganization({
      workspaceId: ctx.workspaceId,
      installationId: ctx.installationId,
      ...(ctx.provider ? { provider: ctx.provider } : {}),
    });
    return installation;
  },

  /**
   * Remove an installation on uninstall (the `installation` webhook with
   * `action: deleted`, MOTIR-892). System context — the webhook has no active
   * workspace. Cascades to every organisation's link row, repos and PR rows.
   * Idempotent: a redelivered uninstall (row already gone) is a no-op returning
   * `false` and enqueues nothing. Returns whether a row was actually removed.
   *
   * PER ORGANISATION since MOTIR-8221: the repos are read BEFORE the delete, so
   * each one's `owner/name` and the workspace that owns it are known, and after
   * commit every workspace's code graph is offboarded for its own repos only.
   */
  async removeInstallation(installationId: string): Promise<boolean> {
    const { removed, refsByWorkspace } = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { removed: false, refsByWorkspace: new Map<string, string[]>() };
      const repos = await githubRepoRepository.listByInstallation(installation.id, tx);
      const refsByWorkspace = new Map<string, string[]>();
      for (const repo of repos) {
        const refs = refsByWorkspace.get(repo.workspaceId) ?? [];
        refs.push(`${repo.owner}/${repo.name}`);
        refsByWorkspace.set(repo.workspaceId, refs);
      }
      const count = await githubInstallationRepository.deleteByInstallationId(installationId, tx);
      return { removed: count > 0, refsByWorkspace };
    });

    // POST-COMMIT, BEST-EFFORT, one workspace at a time: an uninstall is a
    // disconnect of every repository it carried (`repo_disconnected`).
    for (const [workspaceId, refs] of refsByWorkspace) {
      await codeGraphOffboardingService.enqueueForRepos(workspaceId, refs, 'repo_disconnected');
    }
    return removed;
  },

  /**
   * The workspace's installation + its selected repos, or null when the
   * workspace has no installation (a valid "not connected" state the UI shows —
   * it does NOT require a bound member identity). READ path, workspace context.
   */
  async getWorkspaceInstallation(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<GithubInstallationDTO | null> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const installation = await githubInstallationRepository.findByWorkspaceId(
          ctx.workspaceId,
          tx,
        );
        if (!installation) return null;
        const repos = await githubRepoRepository.listByInstallation(installation.id, tx);
        return toGithubInstallationDTO(installation, repos);
      },
    );
  },

  /**
   * THE ORGANISATION'S GitHub connections — the org-tier sibling of
   * {@link getWorkspaceInstallation}, and the read every ORGANISATION surface
   * owes (MOTIR-4836).
   *
   * ⚠️ IT IS NOT A WIDER `getWorkspaceInstallation`, IT IS A DIFFERENT
   * QUESTION. That method is honestly named and does what it says; it was
   * simply the only installation lookup that existed when the organisation tier
   * did not. `findByWorkspaceId` filters on `workspace_id` in the SQL, so a
   * sibling workspace of the same organisation matches nothing no matter what
   * is bound — which is why the fix needed BOTH this read and the
   * `github_installation_org_read` policy arm, and why neither alone changes
   * what a reader sees.
   *
   * ⚠️ IT RETURNS THE SET, and the caller renders it. An organisation with two
   * workspaces can hold two installations on two different GitHub accounts;
   * collapsing that to one row here would be a guess made in the layer with the
   * least standing to make it. Callers that only need "is anything connected?"
   * read `.length`; the organisation's Git page renders one row per connection,
   * which for the overwhelmingly common N = 1 is byte-identical to the singular
   * card it replaces. Same disposition as
   * `organizationRepoService.listRepositoryUsage`.
   *
   * The context mirrors that method exactly: ONE workspace-bound transaction
   * that resolves the organisation from the actor's WORKSPACE row (trusted, not
   * request input), asserts membership, and only then binds
   * `app.organization_id` so the FOR SELECT arm answers. An unbound read is
   * refused rather than wrong — the MOTIR-2956 shape, which is why the binding
   * and the read are in the same transaction.
   *
   * ⚠️ IT READS THE LINKS, NOT THE STAMP (Story MOTIR-8216 · MOTIR-8223). Once
   * one installation can be linked to several organisations, the installation
   * row's `organization_id` names only the FIRST of them, so a read keyed on it
   * showed a second organisation no account at all — `Connect GitHub` on the
   * very account its repositories came from. The organisation's accounts are
   * the installations stamped with it PLUS its `github_installation_org_link`
   * rows — the stamp still carries every connection with no link row (a GitLab
   * connection, a seeded or provisioning installation) — and each account's
   * repositories are only THIS organisation's on it: another organisation's
   * repositories on a shared account are not this card's to count.
   */
  async listOrganizationInstallations(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<GithubInstallationDTO[]> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
        await assertOrgMember(ctx.userId, organizationId, tx);
        await bindOrganizationContext(tx, organizationId);
        const stamped = await githubInstallationRepository.listByOrganizationId(organizationId, tx);
        const links = await githubInstallationOrgLinkRepository.listByOrganizationId(
          organizationId,
          tx,
        );
        const seen = new Set(stamped.map((installation) => installation.id));
        const installations = [
          ...stamped,
          ...links
            .map((link) => link.installation)
            .filter((installation) => !seen.has(installation.id)),
        ];
        const dtos: GithubInstallationDTO[] = [];
        for (const installation of installations) {
          const repos = await githubRepoRepository.listByInstallationAndOrg(
            installation.id,
            organizationId,
            tx,
          );
          dtos.push(toGithubInstallationDTO(installation, repos));
        }
        return dtos;
      },
    );
  },

  /**
   * THE ORGANISATION'S BOUND GITHUB INSTALLATIONS — *is anything installed for
   * this organisation?* (Story MOTIR-8241 · MOTIR-8472), at the ORGANISATION
   * tier, inside the caller's transaction.
   *
   * ⚠️ A UNION OF TWO SOURCES, because the two binding write paths are distinct:
   * `bindInstallationForWorkspace` stamps the installation row with the workspace's
   * organisation, while `linkExistingInstallation` (the setup route's organisation
   * branch) writes only a `github_installation_org_link` row. Reading either one
   * alone misses a real bound organisation. De-duplicated by installation, in the
   * same order {@link listOrganizationInstallations} renders.
   *
   * Motir's shared provisioning installation has a NULL organisation, so the
   * stamped read (an equality on `organization_id`) never returns it: it can not
   * make a customer organisation report "bound".
   *
   * The caller owns the transaction and must already have resolved
   * `organizationId` from a trusted row (the actor's workspace, never request
   * input); this binds `app.organization_id` so the org read arm answers.
   */
  async listBoundInstallationsForOrganization(ctx: {
    organizationId: string;
    tx: Prisma.TransactionClient;
  }): Promise<Array<{ installationRef: string; accountLogin: string; accountType: string }>> {
    const installations = await boundInstallationRows(ctx.organizationId, ctx.tx);
    return installations.map((installation) => ({
      installationRef: installation.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
    }));
  },

  /**
   * THE ORGANISATION'S CONNECTED SET — *which repositories does this run's
   * organisation have connected, whichever of its workspaces connected them?*
   * (Story MOTIR-8241 · MOTIR-8480).
   *
   * The organisation-tier sibling of `resolveWorkspaceConnectedRepos`, composed
   * rather than re-derived: the workspace's own grant plus the bound
   * installations {@link listBoundInstallationsForOrganization} reads (both
   * binding write paths),
   * each expanded to THIS organisation's repositories on it
   * (`listByInstallationAndOrg` — a shared account's other organisations'
   * repositories are not this one's), de-duplicated by `owner/name`. `indexed`
   * is joined from the SAME workspace-keyed ledger read the workspace reader
   * uses, because the index the migrate wizard waits on is this workspace's.
   *
   * A DB read only — no GitHub round trip. The empty set is `undefined`, never
   * `[]`, exactly as the workspace reader's contract. `organizationId` must come
   * from a trusted row (the run's workspace), never from a request.
   */
  async resolveOrganizationConnectedRepos(ctx: {
    userId: string;
    workspaceId: string;
    organizationId: string;
  }): Promise<JobCodeContext | undefined> {
    const rows = await this.listOrganizationRepoRows(ctx);
    if (rows.length === 0) return undefined;
    return {
      repos: rows.map(({ repoRef, provider, defaultBranch, indexed }) => ({
        provider,
        repoRef,
        defaultBranch,
        indexed,
      })),
    };
  },

  /**
   * The index target for one of the organisation's connected repositories:
   * the provider installation it is reachable through, and its coordinates —
   * what `system.code-graph-index` needs to give THIS workspace its own index of
   * an organisation repository (MOTIR-8480). Null when the organisation has no
   * such repository. Same read as {@link resolveOrganizationConnectedRepos}.
   */
  async resolveOrganizationIndexTarget(ctx: {
    userId: string;
    workspaceId: string;
    organizationId: string;
    repoRef: string;
  }): Promise<{
    installationRef: string;
    repoOwner: string;
    repoName: string;
    defaultBranch: string;
  } | null> {
    const rows = await this.listOrganizationRepoRows(ctx);
    const row = rows.find((r) => r.repoRef === ctx.repoRef);
    if (!row) return null;
    return {
      installationRef: row.installationRef,
      repoOwner: row.owner,
      repoName: row.name,
      defaultBranch: row.defaultBranch,
    };
  },

  /** The one read behind the two methods above, in ONE workspace-bound
   *  transaction: bound installations → this organisation's repositories on each
   *  → de-duplicated by `owner/name`, in installation then repository order, with
   *  the workspace's succeeded-index ledger joined. */
  async listOrganizationRepoRows(ctx: {
    userId: string;
    workspaceId: string;
    organizationId: string;
  }): Promise<OrganizationRepoRow[]> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const repos = await organizationGithubReposIn(ctx.workspaceId, ctx.organizationId, tx);
        // One ledger read for the whole set, and only when there IS a set — the
        // shape `resolveWorkspaceConnectedRepos` uses.
        const indexedRefs =
          repos.length === 0
            ? []
            : await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx);
        return repos.map(({ repo, installationRef }) => {
          const repoRef = `${repo.owner}/${repo.name}`;
          return {
            repoRef,
            owner: repo.owner,
            name: repo.name,
            provider: repo.provider,
            defaultBranch: repo.defaultBranch,
            installationRef,
            indexed: indexedRefs.includes(repoRef),
          };
        });
      },
    );
  },

  /**
   * The same connected set's index POINTERS (MOTIR-8768): each repository's
   * `indexingRunId` and size refusal, which neither the planning-envelope shape
   * nor the installation DTO carries. Reads no ledger, so a caller that already
   * holds one (the project-state read pins a single ledger read) adds none.
   */
  async listOrganizationRepoIndexPointers(ctx: {
    userId: string;
    workspaceId: string;
    organizationId: string;
  }): Promise<OrganizationRepoIndexPointer[]> {
    return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) =>
      (await organizationGithubReposIn(ctx.workspaceId, ctx.organizationId, tx)).map(
        ({ repo }) => ({
          repoRef: `${repo.owner}/${repo.name}`,
          indexingRunId: repo.indexingRunId,
          indexRefusedAt: repo.indexRefusedAt,
        }),
      ),
    );
  },

  /**
   * THE SAME CONNECTED SET, FOR A CALLER WITH NO ACTING USER — the migrate index
   * sweep (MOTIR-8768), whose exit predicate must answer from the set the wizard's
   * own exit check reads, not from a second definition of "connected". A cron
   * tick has no user to bind, so the read runs in the system context the sweep's
   * discovery scan already uses; the organisation is derived from the stored
   * workspace row, never taken from input. Refs only — nothing else leaves it.
   */
  async listOrganizationConnectedRepoRefsAsSystem(workspaceId: string): Promise<string[]> {
    return withSystemContext(async (tx) => {
      const organizationId = await resolveOrganizationId(workspaceId, tx);
      const repos = await organizationGithubReposIn(workspaceId, organizationId, tx);
      return repos.map(({ repo }) => `${repo.owner}/${repo.name}`);
    });
  },

  /**
   * Mint a short-lived installation access token for the workspace's
   * installation, dispatched THROUGH the provider seam by the stored `provider`
   * discriminator (so GitLab would work with no change here). Never persists the
   * token. Returns null when the workspace has no installation.
   */
  async mintAccessTokenForWorkspace(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<InstallationToken | null> {
    const installation = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => githubInstallationRepository.findByWorkspaceId(ctx.workspaceId, tx),
    );
    if (!installation) return null;
    const provider = getGitProvider(installation.provider as GitProviderId);
    return provider.mintInstallationToken(installation.installationId);
  },
};

/** The repositories in `repos` that a DIFFERENT organisation already owns —
 *  read under the system context, since the owner is another tenant. Names the
 *  repositories only, never their owner. */
async function conflictingRepositories(
  provider: string,
  organizationId: string,
  repos: NormalizedRepo[],
  tx: Prisma.TransactionClient,
): Promise<ConflictingRepository[]> {
  const conflicts: ConflictingRepository[] = [];
  for (const repo of repos) {
    const rows = await githubRepoRepository.findByHostRepoId(provider, repo.providerRepoId, tx);
    if (rows.some((row) => row.organizationId !== organizationId)) {
      conflicts.push({ repoId: repo.providerRepoId, fullName: `${repo.owner}/${repo.name}` });
    }
  }
  return conflicts;
}

/** Mirror each repository under the organisation that owns it. */
async function upsertRepos(
  installationId: string,
  workspaceId: string,
  organizationId: string,
  repos: NormalizedRepo[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  for (const repo of repos) {
    await githubRepoRepository.upsert(
      {
        installationId,
        // The repo's OWN tenancy (MOTIR-1931) and the tier that OWNS it
        // (MOTIR-4649), stamped on every write.
        workspaceId,
        organizationId,
        repoId: repo.providerRepoId,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        // The host's own liveness, re-stamped on every reconcile (MOTIR-1959).
        archived: repo.archived,
      },
      tx,
    );
  }
}

/** The org-admin gate every connect door shares: an admin (`manageOrgSettings`,
 *  the capability the Git room's writes hold) of an organisation that is not
 *  closing. A non-member is a 404, a plain member a 403, a closing org a 409. */
async function authoriseOrgAdmin(actorUserId: string, organizationId: string): Promise<void> {
  await withOrgContext({ userId: actorUserId, organizationId }, async (tx) => {
    await assertOrgCapability(actorUserId, organizationId, 'manageOrgSettings', tx);
    await assertOrgNotClosing(organizationId, tx);
  });
}

/** The installations the actor's linked GitHub identity can access, or null
 *  when the actor has no linked identity. */
async function accessibleInstallations(
  actorUserId: string,
): Promise<GithubUserInstallation[] | null> {
  const live = await githubIdentityService.getLiveToken(actorUserId);
  if (!live) return null;
  return userInstallationsClient.listForToken(live.accessToken);
}

/** Refuse an installation the actor cannot see on GitHub. See
 *  `linkExistingInstallation` for the one bounded `install_return` relaxation. */
async function assertInstallationAccessible(
  actorUserId: string,
  installationId: string,
  via: 'picker' | 'install_return',
): Promise<void> {
  const accounts = await accessibleInstallations(actorUserId);
  if (accounts === null) {
    if (via === 'install_return') return;
    throw new InstallationNotAccessibleError();
  }
  if (!accounts.some((account) => account.installationId === installationId)) {
    throw new InstallationNotAccessibleError();
  }
  const row = await withSystemContext((tx) =>
    githubInstallationRepository.findByInstallationId(installationId, tx),
  );
  if (row && isSharedProvisioningInstallation(row)) throw new InstallationNotAccessibleError();
}

/** Motir's shared provisioning installation (MOTIR-1931): no tenancy at all. */
function isSharedProvisioningInstallation(row: {
  workspaceId: string | null;
  organizationId: string | null;
}): boolean {
  return row.workspaceId === null && row.organizationId === null;
}

/** Which of the organisation's workspaces a link is made FROM: the hint when it
 *  belongs to the organisation, otherwise the organisation's oldest workspace.
 *  With `strict`, a hint outside the organisation is a refusal rather than
 *  ignored — the install round trip's signed state must agree with itself. */
async function workspaceForOrganization(
  organizationId: string,
  hint: string | undefined,
  strict: boolean,
): Promise<string> {
  return withSystemContext(async (tx) => {
    if (hint) {
      const workspace = await workspaceRepository.findByIdInTx(hint, tx);
      if (workspace?.organizationId === organizationId) return workspace.id;
      if (strict) throw new OrgForbiddenError(hint, organizationId);
    }
    const [first] = await workspaceRepository.listByOrganization(organizationId, tx);
    if (!first) throw new OrgForbiddenError('', organizationId);
    return first.id;
  });
}
