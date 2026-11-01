import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import { CustomerRepositoryNotDeployableError } from '@/lib/hosting/errors';
import { decodeReleaseCursor, encodeReleaseCursor } from '@/lib/hosting/releaseCursor';
import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionRollbackService } from '@/lib/services/productionRollbackService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The PRODUCTION PANEL's server side (Story MOTIR-9797 · MOTIR-10036): the read
// behind `GET …/repositories/[rowId]/production`, and the rollback behind its
// `POST …/rollback`, each resolving the repository the same way.
//
// ⚠️ NOT FOUND, NEVER FORBIDDEN, FOR WHAT THE VIEWER CANNOT HAVE. A project the
// viewer cannot browse, a repository id that is not in the path's project, and a
// customer repository all fail as not found, so one repository's id can never be
// used through another project's path and no response confirms a repository
// exists. Only the rollback itself answers forbidden, to an administrator check
// the rollback service owns.

/** The release history's page size — the five rows a page of the approved design
 *  draws before Show more (MOTIR-10024) — and its ceiling. The rollback answers
 *  the first page at this size too, so the panel it re-renders keeps its length. */
export const RELEASE_PAGE_DEFAULT = 5;
export const RELEASE_PAGE_MAX = 50;

export interface ProductionPanelInput {
  projectKey: string;
  projectRepositoryId: string;
  actor: ServiceContext;
  cursor?: string | null;
  limit?: number | null;
}

/** The repository named by the path, if the actor may see it and Motir hosts it. */
async function resolveRepository(
  projectKey: string,
  projectRepositoryId: string,
  actor: ServiceContext,
): Promise<{ projectId: string }> {
  // Browse-gated: a non-browser fails as ProjectNotFoundError.
  const project = await projectsService.getByKey(projectKey, actor);
  const rows = await projectRepoSetService.listByProject(project.id, actor);
  const row = rows.find((r) => r.id === projectRepositoryId);
  if (!row) throw new ProjectRepoNotFoundError(projectRepositoryId);
  if (isOrganizationSeedSource(row.seedSource)) {
    throw new CustomerRepositoryNotDeployableError(projectRepositoryId);
  }
  return { projectId: project.id };
}

function pageSize(limit: number | null | undefined): number {
  if (limit === null || limit === undefined) return RELEASE_PAGE_DEFAULT;
  return Math.min(Math.max(1, Math.floor(limit)), RELEASE_PAGE_MAX);
}

async function panelFor(
  projectId: string,
  input: ProductionPanelInput,
): Promise<ProductionPanelDto> {
  const { projectRepositoryId, actor } = input;
  // Decoded first, so a malformed cursor is a 400 even before any release exists.
  const decoded = input.cursor ? decodeReleaseCursor(input.cursor) : null;
  const permissions = await projectAccessService.getPermissions(projectId, actor);
  // The room's VIEW key, asserted where the read happens (the settings rail's
  // `production` entry names it). `projectsService.getByKey` already refused a
  // non-browser; this keeps the key the door opens on in the read itself.
  if (!permissions.has('project:browse')) throw new ProjectNotFoundError(projectId);
  const isAdministrator = permissions.has('project:administer');
  const app = await hostedApplicationService.getApplicationForRepository(
    actor.workspaceId,
    projectRepositoryId,
  );
  if (!app) {
    return {
      application: null,
      currentRelease: null,
      previousRelease: null,
      releases: [],
      nextCursor: null,
      isAdministrator,
      canRollback: false,
    };
  }

  const take = pageSize(input.limit);
  const after = decoded ? { createdAt: new Date(decoded.createdAt), id: decoded.id } : null;
  // One more than the page, to know whether another page exists.
  const fetched = await hostedApplicationService.listReleasesPage(actor.workspaceId, app.id, {
    after,
    take: take + 1,
  });
  const releases: HostedReleaseDto[] = fetched.slice(0, take);
  const last = releases[releases.length - 1];
  return {
    application: { id: app.id, target: app.target, productionAddress: app.productionAddress },
    currentRelease: app.currentRelease,
    previousRelease: app.previousRelease,
    releases,
    nextCursor:
      fetched.length > take && last
        ? encodeReleaseCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    isAdministrator,
    canRollback: isAdministrator && app.previousRelease !== null,
  };
}

/** The panel for a repository: its application, current and previous release,
 *  a page of history, and what the viewer may do. */
async function getProductionPanel(input: ProductionPanelInput): Promise<ProductionPanelDto> {
  const { projectId } = await resolveRepository(
    input.projectKey,
    input.projectRepositoryId,
    input.actor,
  );
  return panelFor(projectId, input);
}

/** Roll the repository back, then answer the panel's first page, so the client
 *  re-renders from the response. Who may roll back is the rollback service's. */
async function rollback(
  input: Pick<ProductionPanelInput, 'projectKey' | 'projectRepositoryId' | 'actor'>,
): Promise<ProductionPanelDto> {
  const { projectId } = await resolveRepository(
    input.projectKey,
    input.projectRepositoryId,
    input.actor,
  );
  await productionRollbackService.rollbackProduction({
    projectRepositoryId: input.projectRepositoryId,
    actor: input.actor,
  });
  return panelFor(projectId, input);
}

export const productionPanelService = { getProductionPanel, rollback };
