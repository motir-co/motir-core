import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { IdlePolicyDto } from '@/lib/dto/idlePolicy';
import type { HostedApplicationDto } from '@/lib/dto/hostedApplications';
import type { ProductionHandoverDto, ProductionPanelDto } from '@/lib/dto/productionPanel';
import { CustomerRepositoryNotDeployableError } from '@/lib/hosting/errors';
import { decodeReleaseCursor, encodeReleaseCursor } from '@/lib/hosting/releaseCursor';
import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import type { HostedIdlePolicy } from '@/lib/hosting/idlePolicy';
import {
  EXPORT_RETENTION_DAYS,
  hostedApplicationExportService,
} from '@/lib/services/hostedApplicationExportService';
import { hostedApplicationGraceNotifier } from '@/lib/services/hostedApplicationGraceNotifier';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { isOrgAdminForWorkspace } from '@/lib/services/organizationAccessService';
import { hostedIdlePolicyService } from '@/lib/services/hostedIdlePolicyService';
import { productionRollbackService } from '@/lib/services/productionRollbackService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The PRODUCTION PANEL's server side (Story MOTIR-9797 · MOTIR-10036): the read
// behind `GET …/repositories/[rowId]/production`, the rollback behind its
// `POST …/rollback`, and the idle policy behind `GET`/`PUT …/idle-policy`
// (MOTIR-12107), each resolving the repository the same way.
//
// ⚠️ NOT FOUND, NEVER FORBIDDEN, FOR WHAT THE VIEWER CANNOT HAVE. A project the
// viewer cannot browse, a repository id that is not in the path's project, and a
// customer repository all fail as not found, so one repository's id can never be
// used through another project's path and no response confirms a repository
// exists. Only the rollback and the idle-policy change answer forbidden, to the
// administrator checks their own services own.

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

/** The repository named by the path, if the actor may see it and Motir hosts it.
 *  The one resolution every production route shares — the logs read
 *  (MOTIR-12105) included — so not found means the same thing on each. */
export async function resolveRepository(
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
      handover: null,
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
  const handover = await handoverFor(app, projectRepositoryId, actor);
  // Roll back is offered only on a live app the deploy guard still deploys: the
  // takeover's release freeze (MOTIR-12127) refuses it on the server regardless.
  const releasable = app.state === 'live' && handover?.deployRefusal !== 'taken_over';
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
    canRollback: isAdministrator && releasable && app.previousRelease !== null,
    handover,
  };
}

const DAY_MS = 86_400_000;

/** The targets whose stop keeps a final export (an AWS app leaves with its
 *  database). */
const FINAL_EXPORT_TARGETS: ReadonlySet<string> = new Set(['serverless', 'fly']);

/**
 * The takeover facts the panel shows (MOTIR-12138). Every viewer who can browse
 * the project reads the dates, the addresses and the export list; whether the
 * viewer may ACT — Download export, Stop now — is `canManageHandover`, the
 * organisation-admin question the export and stop routes ask themselves. Null
 * only when the repository's organisation cannot be resolved.
 */
async function handoverFor(
  app: HostedApplicationDto,
  projectRepositoryId: string,
  actor: ServiceContext,
): Promise<ProductionHandoverDto | null> {
  const facts = await hostedApplicationService.readHandoverFacts(
    projectRepositoryId,
    app.workspaceId,
  );
  if (!facts) return null;
  const [canManageHandover, notice, exports] = await Promise.all([
    isOrgAdminForWorkspace(actor.userId, app.workspaceId),
    withWorkspaceServiceContext(app.workspaceId, (tx) =>
      hostedApplicationGraceNotifier.latestGraceNotice(app.id, tx),
    ),
    // A live app has never had an export: no read.
    app.state === 'live'
      ? Promise.resolve([])
      : hostedApplicationExportService.listForPanel(app.workspaceId, app.id),
  ]);
  const stoppedAt =
    app.state === 'handed_over' && FINAL_EXPORT_TARGETS.has(app.target) ? app.handedOverAt : null;
  return {
    state: app.state,
    target: app.target,
    stopsAt: app.stopsAt,
    handedOverAt: app.handedOverAt,
    upstreamAddress: app.upstreamAddress,
    handedOverAccountId: app.handedOverAccountId,
    organizationId: facts.organizationId,
    organizationName: facts.organizationName,
    latestGraceNotice: notice ? { kind: notice.kind, sentAt: notice.sentAt.toISOString() } : null,
    canManageHandover,
    deployRefusal: facts.deployRefusal,
    exports,
    finalExportExpiresAt: stoppedAt
      ? new Date(Date.parse(stoppedAt) + EXPORT_RETENTION_DAYS.final * DAY_MS).toISOString()
      : null,
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

/** The application's idle policy (MOTIR-12107), for anyone who can browse the
 *  project; `editable` says whether the viewer is an administrator. */
async function getIdlePolicy(
  input: Pick<ProductionPanelInput, 'projectKey' | 'projectRepositoryId' | 'actor'>,
): Promise<IdlePolicyDto> {
  const { projectId } = await resolveRepository(
    input.projectKey,
    input.projectRepositoryId,
    input.actor,
  );
  const permissions = await projectAccessService.getPermissions(projectId, input.actor);
  if (!permissions.has('project:browse')) throw new ProjectNotFoundError(projectId);
  return hostedIdlePolicyService.readIdlePolicy({
    projectRepositoryId: input.projectRepositoryId,
    isAdministrator: permissions.has('project:administer'),
  });
}

/** Change the application's idle policy and apply it to the serving release.
 *  Who may change it is the idle-policy service's. */
async function setIdlePolicy(
  input: Pick<ProductionPanelInput, 'projectKey' | 'projectRepositoryId' | 'actor'> & {
    policy: HostedIdlePolicy;
  },
): Promise<IdlePolicyDto> {
  await resolveRepository(input.projectKey, input.projectRepositoryId, input.actor);
  return hostedIdlePolicyService.setIdlePolicy({
    projectRepositoryId: input.projectRepositoryId,
    policy: input.policy,
    actor: input.actor,
  });
}

export const productionPanelService = {
  getProductionPanel,
  rollback,
  getIdlePolicy,
  setIdlePolicy,
};
