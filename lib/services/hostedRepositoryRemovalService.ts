import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import {
  hostedApplicationRepository,
  type HostedApplicationTeardown,
} from '@/lib/repositories/hostedApplicationRepository';
import { previewDeploymentRepository } from '@/lib/repositories/previewDeploymentRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { hostInstallationIdOf } from '@/lib/services/projectRepoTakeoverService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { previewLifecycleService } from '@/lib/services/previewLifecycleService';
import { productionTeardownService } from '@/lib/services/productionTeardownService';
import { repoDeletionClient } from '@/lib/github/repoDeletion';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';
import type { HostedRepositoryRemovalDto } from '@/lib/dto/projectRepos';
import {
  HostedRepositoryCheckFailedError,
  HostedRepositoryDeletionError,
  ProjectRepoNotFoundError,
  ProjectRepoRemovalBlockedError,
} from '@/lib/projectRepos/errors';

// REMOVING A MOTIR-HOSTED REPOSITORY FROM A PROJECT (bug MOTIR-11979 · MOTIR-11981;
// design/repository-set/design-notes.md §19).
//
// A hosted repository lives in Motir's provisioning organisation and only this
// project can use it, so the row-only remove the organisation links get (§17.6,
// `projectRepoSetService.removeRow`) would orphan it: a private repository nobody
// can reach, still running whatever runs from it. So a hosted row that Motir still
// holds is DELETED with its row, together with everything that runs from it, and a
// hosted row with nothing of Motir's left to delete is simply removed.
//
// ⚠️ THE DELETE IS A SEQUENCE, EACH STEP IDEMPOTENT, THE ROW DELETED LAST (§19.6 —
// the organisation offboarding's own discipline, MOTIR-6397):
//
//   1. mark the row as being deleted (`hosted_deletion_started_at`);
//   2. previews off and torn down — the same two calls a takeover makes;
//   3. production torn down — its release's usage settled, its app destroyed, its
//      database deleted, then its `hosted_application` row deleted (its releases
//      cascade; every bound custom domain is released by the schema's `SetNull`);
//   4. the GitHub repository deleted (`404` is success) — `isMotirHostedOwner`
//      asserted on it immediately before the call;
//   5. the row deleted through `removeRow`, its cascades (environment values,
//      work-item links) with it, and the runner group re-synced.
//
// A step that fails stops the sequence with the stamp still on the row, so the room
// reads "Deletion didn't finish" and Try again re-runs the same sequence: every step
// already done is a no-op the second time, and the fresh check lists only what is
// left. The host calls hold no transaction (the side-effects-outside-tx rule).
//
// ⚠️ ORGANISATION LINKS ARE UNTOUCHED. `remove` hands a link straight to
// `removeRow`, exactly as the route did before this card; only a Motir-hosted row
// takes the sequence.
//
// ⚠️ WHAT IS KEPT. The `github_repo` row and its pull-request records stay (as
// `removeRow` already un-claims rather than deletes the mirror), so a work item's
// history — including the pull requests it links — survives the delete.

/** The takeover states in which the repository is on its way to the person's own
 *  account: neither a delete nor a remove is offered until it lands (§19.3). */
const HAND_OFF_IN_FLIGHT = new Set(['requested', 'transfer_pending', 'awaiting_reinstall']);

/** Where the row's repository stands, before any host read. */
type Holding = 'motir' | 'gone' | 'never' | 'yours';

/**
 * Whether Motir still HOLDS the row's repository — created by Motir, in an org
 * Motir owns, and not taken over. A `failed` takeover is still Motir's (GitHub
 * refused the transfer). A realized-less `created` row is a repository that was
 * deleted on GitHub and whose mirror went with it.
 */
function holdingOf(row: ProjectRepoWithRealized, owners: readonly string[]): Holding {
  if (row.takeoverState === 'done' || row.state === 'connected') return 'yours';
  if (row.state !== 'created') return 'never';
  if (!row.githubRepo) return 'gone';
  return isMotirHostedOwner(row.githubRepo.owner, owners) ? 'motir' : 'yours';
}

/** Whether the application has a production to tear down: an app, a release
 *  that ran on one, or a database. */
function hasProduction(app: HostedApplicationTeardown | null): app is HostedApplicationTeardown {
  return (
    app !== null &&
    (app.productionAppName !== null ||
      app.currentReleaseId !== null ||
      app.previousReleaseId !== null ||
      app.databaseProjectId !== null)
  );
}

/** A short, safe sentence for a failed step — never a raw host body. */
function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

export const hostedRepositoryRemovalService = {
  /**
   * WHAT THE DELETE WOULD REMOVE (§19.4) — the read the confirm makes when it
   * opens, and again on Check again or Try again. Asks GitHub whether the
   * repository still exists through the provisioning installation; a GitHub that
   * cannot answer is {@link HostedRepositoryCheckFailedError}, never a guess.
   */
  async getRemovalImpact(rowId: string, ctx: ServiceContext): Promise<HostedRepositoryRemovalDto> {
    const row = await this.readForRemoval(rowId, ctx);
    let repository: Holding = holdingOf(row, await motirOwnedOrgLogins());
    if (repository === 'motir') {
      const realized = row.githubRepo!;
      try {
        const installationId = await hostInstallationIdOf(realized.installationId);
        const found = await repoDeletionClient.probeRepo({
          installationId,
          owner: realized.owner,
          repo: realized.name,
        });
        if (found === 'absent') repository = 'gone';
      } catch (err) {
        throw new HostedRepositoryCheckFailedError(detailOf(err));
      }
    }

    const [app, counts, previews] = await Promise.all([
      withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        hostedApplicationRepository.findTeardownByProjectRepository(rowId, tx),
      ),
      withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: row.projectId },
        async (tx) => ({
          environmentValues: await projectRepoRepository.countEnvironmentValues(rowId, tx),
          openWorkItems: await projectRepoRepository.countOpenWorkItemsTargeting(
            rowId,
            ctx.workspaceId,
            tx,
          ),
        }),
      ),
      row.githubRepo
        ? withSystemContext((tx) =>
            previewDeploymentRepository.listOpenForRepo(row.githubRepo!.id, tx),
          ).then((open) => open.length)
        : Promise.resolve(0),
    ]);

    const production = hasProduction(app)
      ? { address: app.productionAddress ?? app.slug, domains: app.customDomainCount }
      : null;
    return {
      repository,
      production,
      previews,
      ...counts,
      destructive: repository === 'motir' || production !== null || previews > 0,
    };
  },

  /**
   * REMOVE a row from the Repositories room — the one door the room's DELETE
   * calls. An organisation link goes to `removeRow` unchanged; a Motir-hosted row
   * runs the delete sequence (§19.6). Idempotent: an already-gone row is a no-op.
   *
   * @throws ProjectRepoRemovalBlockedError while a takeover hand-off is in flight.
   * @throws HostedRepositoryDeletionError when a host step fails; the row keeps
   *   its stamp and a retry finishes the rest.
   */
  async remove(rowId: string, ctx: ServiceContext): Promise<void> {
    const existing = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      projectRepoRepository.findById(rowId, ctx.workspaceId, tx),
    );
    if (!existing) return;
    if (isOrganizationSeedSource(existing.seedSource)) {
      await projectRepoSetService.removeRow(rowId, ctx);
      return;
    }

    const row = await this.readForRemoval(rowId, ctx);
    const holding = holdingOf(row, await motirOwnedOrgLogins());
    const app = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      hostedApplicationRepository.findTeardownByProjectRepository(rowId, tx),
    );

    // ── 1 · mark the row as being deleted — before the first host call, so a
    //       crash anywhere after it reads as an unfinished delete.
    if (holding === 'motir' || app !== null || row.githubRepo !== null) {
      await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: row.projectId },
        (tx) => projectRepoRepository.markHostedDeletionStarted(rowId, new Date(), tx),
      );
    }

    // ── 2 · previews: the credential withdrawn while Motir can still reach the
    //       repository, then every open preview closed and torn down.
    if (row.githubRepo) {
      try {
        // Only on a repository Motir holds: a taken-over one is the person's,
        // and Motir does not touch its settings (the apps it runs still go).
        if (holding === 'motir') await previewEnablementService.disable(rowId);
        await previewLifecycleService.teardownRepository(rowId, {
          pushNamespace: row.previewPushNamespace,
        });
      } catch (err) {
        throw new HostedRepositoryDeletionError('previews', detailOf(err));
      }
    }

    // ── 3 · production: usage settled first, then the app, its database, and
    //       the application row (releases cascade, custom domains released).
    if (app) {
      try {
        await this.tearDownProduction(app, row.workspaceId);
      } catch (err) {
        throw new HostedRepositoryDeletionError('production', detailOf(err));
      }
    }

    // ── 4 · the GitHub repository — only one Motir hosts, asserted right here.
    if (holding === 'motir') {
      const realized = row.githubRepo!;
      if (!isMotirHostedOwner(realized.owner, await motirOwnedOrgLogins())) {
        throw new HostedRepositoryDeletionError(
          'repository',
          'the repository is not in an organisation Motir hosts',
        );
      }
      try {
        const installationId = await hostInstallationIdOf(realized.installationId);
        await repoDeletionClient.deleteRepo({
          installationId,
          owner: realized.owner,
          repo: realized.name,
        });
      } catch (err) {
        throw new HostedRepositoryDeletionError('repository', detailOf(err));
      }
    }

    // ── 5 · the row LAST — its cascades, the merge-mode seed and the runner-group
    //       re-sync are `removeRow`'s own, unchanged.
    await projectRepoSetService.removeRow(rowId, ctx);
  },

  /** Production's teardown. Each call is idempotent on a second run: a destroyed
   *  app returns no usage, a deleted database zero, a deleted row nothing. */
  async tearDownProduction(app: HostedApplicationTeardown, workspaceId: string): Promise<void> {
    await productionTeardownService.removeProductionApp(app, workspaceId);
    await productionTeardownService.deleteProductionDatabase(app, workspaceId);
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      hostedApplicationRepository.deleteById(app.id, tx),
    );
  },

  /** The row, the caller's `repository:manage` on its project (the room's
   *  permission, §19.2), and the refusal while a hand-off is in flight. */
  async readForRemoval(rowId: string, ctx: ServiceContext): Promise<ProjectRepoWithRealized> {
    const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      projectRepoRepository.findById(rowId, ctx.workspaceId, tx),
    );
    if (!row) throw new ProjectRepoNotFoundError(rowId);
    await projectAccessService.assertPermission(row.projectId, ctx, 'repository:manage');
    if (row.takeoverState && HAND_OFF_IN_FLIGHT.has(row.takeoverState)) {
      throw new ProjectRepoRemovalBlockedError(rowId);
    }
    return row;
  },
};
