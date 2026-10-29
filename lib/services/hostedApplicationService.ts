import type { Prisma } from '@/generated/prisma/client';
import type { HostedApplicationDto, HostedReleaseDto } from '@/lib/dto/hostedApplications';
import {
  applicationHostForWorkspaceHostname,
  deriveApplicationSlug,
} from '@/lib/hosting/applicationAddress';
import { deployEligibilityRefusal } from '@/lib/hosting/deployEligibility';
import {
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  HostingTargetMissingError,
  IllegalReleaseTransitionError,
  ReleaseNotOfApplicationError,
  RepositoryNotEstablishedError,
} from '@/lib/hosting/errors';
import {
  isLegalReleaseTransition,
  type HostedReleaseCause,
  type HostedReleaseState,
} from '@/lib/hosting/vocabulary';
import {
  toHostedApplicationDto,
  toHostedReleaseDto,
  type HostedApplicationWithReleases,
} from '@/lib/mappers/hostedApplicationMappers';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import {
  hostedReleaseRepository,
  type HostedReleaseStamp,
} from '@/lib/repositories/hostedReleaseRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// A Motir repository's PRODUCTION home (Story MOTIR-9797 · MOTIR-10026): one
// `hosted_application` per repository row and one `hosted_release` per release.
// This service keeps the model's invariants and nothing else — it calls no deploy
// port, runs no migration and decides no address format beyond the decision's
// (MOTIR-9790, ADR public-tenant-addresses §8 AMENDMENT 4). Later cards decide
// WHEN to create, move and swap; this one makes each of those safe to do.
//
// Contexts: the writers run from the merge webhook and from jobs, so a write
// with no `tx` opens `withSystemContext`. The reads a member's request makes take
// the WORKSPACE, so row-level security confines them to it whatever id arrives.

/** The default page of a release history. */
const DEFAULT_RELEASE_PAGE = 20;

/** A repository's production switch — see `getProductionSwitch`. */
export interface ProductionSwitch {
  applicationId: string;
  /** The production app releases deploy to, `mh-<rid>` on Fly. */
  appName: string;
  enabledAt: string;
}

/** Optional values a move records beside the new state. */
export type ReleaseTransitionDetails = Pick<
  HostedReleaseStamp,
  'failureReason' | 'artifactRef' | 'providerReleaseId'
>;

export interface CreateReleaseInput {
  applicationId: string;
  commitSha: string;
  ref?: string | null;
  cause: HostedReleaseCause;
}

export interface SwapOptions {
  /** What the outgoing current release becomes: `replaced` for a new release,
   *  `rolled_back` when a rollback takes it out. */
  outgoing?: Extract<HostedReleaseState, 'replaced' | 'rolled_back'>;
}

function inSystem<T>(
  tx: Prisma.TransactionClient | undefined,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : withSystemContext(fn);
}

/** The stamps a move into `to` writes: the time a release went live, and the
 *  time it stopped (cleared again when a rollback revives it). */
function stampFor(to: HostedReleaseState, now: Date): HostedReleaseStamp {
  if (to === 'live') return { liveAt: now, endedAt: null };
  if (to === 'failed' || to === 'replaced' || to === 'rolled_back') return { endedAt: now };
  return {};
}

function refuseIneligible(row: Parameters<typeof deployEligibilityRefusal>[0] & { id: string }) {
  switch (deployEligibilityRefusal(row)) {
    case 'customer_repository':
      throw new CustomerRepositoryNotDeployableError(row.id);
    case 'not_established':
      throw new RepositoryNotEstablishedError(row.id, row.state);
    case 'no_target':
      throw new HostingTargetMissingError(row.id);
    default:
      return;
  }
}

/** The host the workspace's claimed label gives `slug`, or null without one. */
async function addressFor(
  workspaceId: string,
  slug: string,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const subdomain = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
  return subdomain ? applicationHostForWorkspaceHostname(slug, subdomain.hostname) : null;
}

async function requireApplication(
  id: string,
  tx: Prisma.TransactionClient,
): Promise<HostedApplicationWithReleases> {
  const row = await hostedApplicationRepository.findById(id, tx);
  if (!row) throw new ApplicationNotFoundError(id);
  return row;
}

async function moveRelease(
  releaseId: string,
  from: HostedReleaseState,
  to: HostedReleaseState,
  details: ReleaseTransitionDetails,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!isLegalReleaseTransition(from, to)) {
    throw new IllegalReleaseTransitionError(releaseId, from, to, from);
  }
  const stamp = { ...details, ...stampFor(to, new Date()) };
  const moved = await hostedReleaseRepository.transitionState(releaseId, from, to, stamp, tx);
  if (moved === 0) {
    const actual = await hostedReleaseRepository.findById(releaseId, tx);
    throw new IllegalReleaseTransitionError(releaseId, from, to, actual?.state ?? null);
  }
}

export const hostedApplicationService = {
  /**
   * The repository's application, created on first call. Refuses a customer
   * repository, a row that is not established and one with no hosting target,
   * writing nothing. A new application gets its slug (unique in the workspace),
   * its production address when the workspace has claimed a label, and becomes
   * the workspace's default application when it has none.
   *
   * ⚠️ Concurrency: the WORKSPACE row is locked first, so every first deploy of
   * one workspace is serialised — two calls for one repository yield one row,
   * and two repositories whose names derive the same slug get `x` and `x-2`
   * rather than a unique violation. The insert is still `ON CONFLICT DO
   * NOTHING`, so the index arbitrates even a caller that skipped the lock.
   */
  async ensureApplication(projectRepositoryId: string): Promise<HostedApplicationDto> {
    return withSystemContext(async (tx) => {
      const repo = await projectRepoRepository.findDeployFactsInTx(projectRepositoryId, tx);
      if (!repo) throw new ApplicationNotFoundError(projectRepositoryId);
      refuseIneligible(repo);
      // The workspace comes from the stored row, never from input, so binding it
      // grants nothing the id did not already imply.
      await bindWorkspaceContext(tx, repo.workspaceId);
      if (!(await workspaceRepository.lockByIdForUpdate(repo.workspaceId, tx))) {
        throw new ApplicationNotFoundError(projectRepositoryId);
      }

      const existing = await hostedApplicationRepository.findByProjectRepository(repo.id, tx);
      if (existing) return toHostedApplicationDto(existing);

      const taken = new Set(
        await hostedApplicationRepository.listSlugsInWorkspace(repo.workspaceId, tx),
      );
      const slug = deriveApplicationSlug(repo.name, taken);
      const id = await hostedApplicationRepository.insertIfAbsent(
        {
          workspaceId: repo.workspaceId,
          projectId: repo.projectId,
          projectRepositoryId: repo.id,
          target: repo.hostingTarget!,
          slug,
          productionAddress: await addressFor(repo.workspaceId, slug, tx),
        },
        tx,
      );
      if (id) await workspaceRepository.setDefaultApplicationIfUnset(repo.workspaceId, id, tx);
      const row = await hostedApplicationRepository.findByProjectRepository(repo.id, tx);
      return toHostedApplicationDto(row!);
    });
  },

  /**
   * Re-derive the application's production address from its workspace's claimed
   * label: the host, or null when the workspace holds none. Re-assigning when a
   * label is claimed or renamed later is MOTIR-9507's to call.
   */
  async assignProductionAddress(applicationId: string): Promise<HostedApplicationDto> {
    return withSystemContext(async (tx) => {
      const app = await requireApplication(applicationId, tx);
      await bindWorkspaceContext(tx, app.workspaceId);
      const address = await addressFor(app.workspaceId, app.slug, tx);
      await hostedApplicationRepository.setProductionAddress(app.id, address, tx);
      return toHostedApplicationDto({ ...app, productionAddress: address });
    });
  },

  /** The repository's application in `workspaceId`, or null when it has none
   *  (or the repository is not that workspace's). */
  async getApplicationForRepository(
    workspaceId: string,
    projectRepositoryId: string,
  ): Promise<HostedApplicationDto | null> {
    return withWorkspaceServiceContext(workspaceId, async (tx) => {
      const row = await hostedApplicationRepository.findByProjectRepository(
        projectRepositoryId,
        tx,
      );
      return row ? toHostedApplicationDto(row) : null;
    });
  },

  /** The repository's application in whichever workspace holds it, or null —
   *  a SYSTEM read for the jobs that act on a repository by id (MOTIR-10032). */
  async getApplicationForRepositorySystem(
    projectRepositoryId: string,
  ): Promise<HostedApplicationDto | null> {
    return withSystemContext(async (tx) => {
      const row = await hostedApplicationRepository.findByProjectRepository(
        projectRepositoryId,
        tx,
      );
      return row ? toHostedApplicationDto(row) : null;
    });
  },

  /**
   * Whether production is switched on for the repository (MOTIR-10031): its
   * application, the production app it releases to and when it was first
   * enabled — or null when it has no application or production was never
   * switched on. A system read: the merge webhook carries no workspace.
   */
  async getProductionSwitch(projectRepositoryId: string): Promise<ProductionSwitch | null> {
    return withSystemContext(async (tx) => {
      const row = await hostedApplicationRepository.findByProjectRepository(
        projectRepositoryId,
        tx,
      );
      if (!row?.productionEnabledAt || !row.productionAppName) return null;
      return {
        applicationId: row.id,
        appName: row.productionAppName,
        enabledAt: row.productionEnabledAt.toISOString(),
      };
    });
  },

  /** The application's releases, newest first. */
  async listReleases(
    workspaceId: string,
    applicationId: string,
    limit: number = DEFAULT_RELEASE_PAGE,
  ): Promise<HostedReleaseDto[]> {
    return withWorkspaceServiceContext(workspaceId, async (tx) => {
      await requireApplication(applicationId, tx);
      const rows = await hostedReleaseRepository.listByApplication(applicationId, limit, tx);
      return rows.map(toHostedReleaseDto);
    });
  },

  /** A new release of a commit, in `building`. */
  async createRelease(
    input: CreateReleaseInput,
    callerTx?: Prisma.TransactionClient,
  ): Promise<HostedReleaseDto> {
    return inSystem(callerTx, async (tx) => {
      const app = await requireApplication(input.applicationId, tx);
      const row = await hostedReleaseRepository.create(
        {
          workspaceId: app.workspaceId,
          applicationId: app.id,
          commitSha: input.commitSha,
          ref: input.ref ?? null,
          cause: input.cause,
        },
        tx,
      );
      return toHostedReleaseDto(row);
    });
  },

  /**
   * Move a release `from` → `to`. Refuses an edge outside the table, and a
   * release that is no longer in `from`, with `IllegalReleaseTransitionError`;
   * either way no row changes.
   */
  async transitionRelease(
    releaseId: string,
    from: HostedReleaseState,
    to: HostedReleaseState,
    details: ReleaseTransitionDetails = {},
    callerTx?: Prisma.TransactionClient,
  ): Promise<HostedReleaseDto> {
    return inSystem(callerTx, async (tx) => {
      await moveRelease(releaseId, from, to, details, tx);
      return toHostedReleaseDto((await hostedReleaseRepository.findById(releaseId, tx))!);
    });
  },

  /**
   * Make `releaseId` the application's current release: the old current becomes
   * previous, and — when it was live — moves to `outgoing` (`replaced` by
   * default). Holds the application row's lock throughout, so two swaps at once
   * serialise; refuses a release of another application. Runs in the caller's
   * transaction, because the caller's state move belongs to the same unit.
   */
  async swapCurrentRelease(
    applicationId: string,
    releaseId: string,
    tx: Prisma.TransactionClient,
    options: SwapOptions = {},
  ): Promise<HostedApplicationDto> {
    if (!(await hostedApplicationRepository.lockForUpdate(applicationId, tx))) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const release = await hostedReleaseRepository.findById(releaseId, tx);
    if (!release || release.applicationId !== applicationId) {
      throw new ReleaseNotOfApplicationError(releaseId, applicationId);
    }
    const app = await requireApplication(applicationId, tx);
    if (app.currentReleaseId === releaseId) return toHostedApplicationDto(app);

    const outgoing = app.currentRelease;
    if (outgoing?.state === 'live') {
      await moveRelease(outgoing.id, 'live', options.outgoing ?? 'replaced', {}, tx);
    }
    const previous = app.currentReleaseId ?? app.previousReleaseId;
    await hostedApplicationRepository.setPointers(
      applicationId,
      {
        currentReleaseId: releaseId,
        previousReleaseId: previous === releaseId ? null : previous,
      },
      tx,
    );
    return toHostedApplicationDto((await hostedApplicationRepository.findById(applicationId, tx))!);
  },
};
