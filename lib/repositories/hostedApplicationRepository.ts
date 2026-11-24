import { randomUUID } from 'node:crypto';
import type {
  HostedIdleMode,
  HostedReleaseState,
  HostingShape,
  HostingSize,
  HostingTarget,
  Prisma,
} from '@/generated/prisma/client';
import type { HostedApplicationWithReleases } from '@/lib/mappers/hostedApplicationMappers';

// Single-op data access for `hosted_application` — one production home per Motir
// repository row (Story MOTIR-9797 · MOTIR-10026). Reads and writes take a required `tx`;
// the table's `hosted_application_workspace_or_system` policy admits the system
// context the release paths run under and the bound workspace's own session.

/** Who restored a release (MOTIR-10035) and who asked for it (MOTIR-10103),
 *  for its DTO. */
const RELEASE_PEOPLE = {
  restoredBy: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
} as const;
const WITH_RELEASES = {
  currentRelease: { include: RELEASE_PEOPLE },
  previousRelease: { include: RELEASE_PEOPLE },
} as const;
/** The default reads never select the database URL's ciphertext: only
 *  `findDatabaseById` does, for the production database service (MOTIR-10028). */
const WITHOUT_SECRET = { databaseUrlCiphertext: true } as const;

/** What the health prober reads of an application (MOTIR-12106). */
export interface HostedApplicationProbeTarget {
  id: string;
  workspaceId: string;
  projectId: string;
  projectRepositoryId: string;
  target: HostingTarget;
  productionAddress: string | null;
  projectKey: string;
  repositoryName: string;
  seedSource: string;
  currentRelease: {
    id: string;
    state: HostedReleaseState;
    commitSha: string;
    providerReleaseId: string | null;
    providerRef: string | null;
  } | null;
}

/** What the production usage meter reads of an application (MOTIR-12108). */
export interface HostedApplicationMeterTarget {
  id: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  projectRepositoryId: string;
  target: HostingTarget;
  idleMode: HostedIdleMode;
  creditsExhaustedSince: Date | null;
  databaseProjectId: string | null;
  seedSource: string;
  hostingSize: HostingSize | null;
  hostingShape: HostingShape | null;
  /** The organisation's enterprise tenant AWS account's state, or null. */
  tenantAccountState: string | null;
  currentRelease: {
    id: string;
    state: HostedReleaseState;
    liveAt: Date | null;
    providerReleaseId: string | null;
    providerRef: string | null;
  } | null;
}

/** What the production database service reads of an application. */
export interface HostedApplicationDatabaseRow {
  id: string;
  workspaceId: string;
  projectRepositoryId: string;
  target: HostingTarget;
  databaseProjectId: string | null;
  databaseUrlCiphertext: string | null;
}

export interface HostedApplicationInsert {
  workspaceId: string;
  projectId: string;
  projectRepositoryId: string;
  target: HostingTarget;
  slug: string;
  productionAddress: string | null;
  /** The idle policy it starts with (MOTIR-12107), as its two columns. */
  idleMode: HostedIdleMode;
  idleSeconds: number | null;
}

/** The teardown read of {@link hostedApplicationRepository.findTeardownByProjectRepository}. */
export interface HostedApplicationTeardown {
  id: string;
  projectRepositoryId: string;
  target: HostingTarget;
  slug: string;
  productionAddress: string | null;
  productionAppName: string | null;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  databaseProjectId: string | null;
  customDomainCount: number;
}

export const hostedApplicationRepository = {
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationWithReleases | null> {
    return tx.hostedApplication.findUnique({
      where: { id },
      include: WITH_RELEASES,
      omit: WITHOUT_SECRET,
    });
  },

  /**
   * What the host contract reads of the application a customer domain names
   * (ADR MOTIR-9521 §3) — run under the system context, since the contract is
   * anonymous and the domain row already proved which workspace it is.
   */
  async findForHostContract(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    id: string;
    workspaceId: string;
    slug: string;
    target: HostingTarget;
    productionAppName: string | null;
    currentReleaseId: string | null;
    productionAddress: string | null;
    /** Who may open it. No column holds it yet (MOTIR-9817 adds it), so it reads
     *  `null`, which `applicationAccessOf` treats as members only. */
    access: string | null;
  } | null> {
    const row = await tx.hostedApplication.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        slug: true,
        target: true,
        productionAppName: true,
        currentReleaseId: true,
        productionAddress: true,
      },
    });
    return row ? { ...row, access: null } : null;
  },

  async findByProjectRepository(
    projectRepositoryId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationWithReleases | null> {
    return tx.hostedApplication.findUnique({
      where: { projectRepositoryId },
      include: WITH_RELEASES,
      omit: WITHOUT_SECRET,
    });
  },

  async findByProductionAddress(
    productionAddress: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationWithReleases | null> {
    return tx.hostedApplication.findUnique({
      where: { productionAddress },
      include: WITH_RELEASES,
      omit: WITHOUT_SECRET,
    });
  },

  /**
   * The workspace's applications as the Custom domains pane's picker names them
   * (MOTIR-9529): the id it sends, the owning project's name it shows and the
   * slug beside it, by name then slug. An application carries no name of its
   * own, so its project's is the one a member recognises.
   */
  async listForDomainPicker(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; name: string; slug: string }[]> {
    const rows = await tx.hostedApplication.findMany({
      where: { workspaceId },
      select: { id: true, slug: true, project: { select: { name: true } } },
      orderBy: [{ project: { name: 'asc' } }, { slug: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, name: r.project.name, slug: r.slug }));
  },

  /** Every slug the workspace's applications hold — what a new slug must avoid. */
  async listSlugsInWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.hostedApplication.findMany({
      where: { workspaceId },
      select: { slug: true },
    });
    return rows.map((r) => r.slug);
  },

  /**
   * Insert the repository's application unless one exists, ONE statement: the
   * unique index on `project_repository_id` arbitrates two first deploys inside
   * the statement, so the loser inserts nothing rather than failing. Returns the
   * new row's id, or null when the row already existed. `@default(cuid())` and
   * `@updatedAt` are Prisma-side, so the INSERT supplies both (the
   * `repoDeploymentRepository` precedent).
   */
  async insertIfAbsent(
    input: HostedApplicationInsert,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "hosted_application" (
        "id", "workspace_id", "project_id", "project_repository_id", "target",
        "slug", "production_address", "idle_mode", "idle_seconds", "created_at", "updated_at"
      )
      VALUES (
        ${randomUUID()}, ${input.workspaceId}, ${input.projectId},
        ${input.projectRepositoryId}, ${input.target}::"hosting_target", ${input.slug},
        ${input.productionAddress}, ${input.idleMode}::"hosted_idle_mode", ${input.idleSeconds}::int,
        NOW(), NOW()
      )
      ON CONFLICT ("project_repository_id") DO NOTHING
      RETURNING "id"
    `;
    return rows[0]?.id ?? null;
  },

  async setProductionAddress(
    id: string,
    productionAddress: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.hostedApplication.update({ where: { id }, data: { productionAddress } });
  },

  async setSlug(id: string, slug: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.hostedApplication.update({ where: { id }, data: { slug } });
  },

  async setPointers(
    id: string,
    pointers: { currentReleaseId: string | null; previousReleaseId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.hostedApplication.update({ where: { id }, data: pointers });
  },

  /** Record production switched on (MOTIR-10027): the app, when it was first
   *  enabled and when its deploy token was last minted. */
  async markProductionEnabled(
    id: string,
    input: { appName: string; enabledAt: Date; mintedAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.hostedApplication.update({
      where: { id },
      data: {
        productionAppName: input.appName,
        productionEnabledAt: input.enabledAt,
        productionTokenMintedAt: input.mintedAt,
      },
    });
  },

  /** The application's database columns, ciphertext included — the one read
   *  that selects it (MOTIR-10028). */
  async findDatabaseById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationDatabaseRow | null> {
    return tx.hostedApplication.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        projectRepositoryId: true,
        target: true,
        databaseProjectId: true,
        databaseUrlCiphertext: true,
      },
    });
  },

  /**
   * Record the application's production database, ONCE: the UPDATE matches only
   * while no ciphertext is stored, so a second writer changes nothing. Returns
   * whether this call wrote it.
   */
  async setDatabase(
    id: string,
    input: { databaseProjectId: string; databaseUrlCiphertext: string },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.hostedApplication.updateMany({
      where: { id, databaseUrlCiphertext: null },
      data: input,
    });
    return count === 1;
  },

  /**
   * Take the application row's `FOR UPDATE` lock, and report whether it matched.
   * A lock over zero rows locks nothing and reports success, so the caller turns
   * `false` into a refusal (the `workspaceRepository.lockByIdForUpdate` rule).
   */
  /**
   * What deleting a hosted repository must tear down of its application
   * (MOTIR-11981; design/repository-set §19): the production app, its database,
   * the releases that name it and how many custom domains are bound to it. A
   * select, not the release list — the teardown needs only the pointers.
   */
  async findTeardownByProjectRepository(
    projectRepositoryId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationTeardown | null> {
    const row = await tx.hostedApplication.findUnique({
      where: { projectRepositoryId },
      select: {
        id: true,
        projectRepositoryId: true,
        target: true,
        slug: true,
        productionAddress: true,
        productionAppName: true,
        currentReleaseId: true,
        previousReleaseId: true,
        databaseProjectId: true,
        _count: { select: { customDomains: true } },
      },
    });
    if (!row) return null;
    const { _count, ...rest } = row;
    return { ...rest, customDomainCount: _count.customDomains };
  },

  /**
   * Delete an application row once its production app and database are gone
   * (MOTIR-11981). Its releases cascade with it, and every custom domain bound
   * to it is released by the schema's own `SetNull`. Idempotent: an
   * already-deleted row deletes nothing.
   */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.hostedApplication.deleteMany({ where: { id } });
    return result.count;
  },

  /**
   * Forget production's releases and app name once the app is destroyed
   * (MOTIR-11981), so a retried teardown has nothing left on the host to reach.
   */
  async clearProductionPointers(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.hostedApplication.updateMany({
      where: { id },
      data: { currentReleaseId: null, previousReleaseId: null, productionAppName: null },
    });
  },

  /** The application's stored idle policy columns (MOTIR-12107), or null when
   *  no such application exists. */
  async findIdlePolicy(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ idleMode: HostedIdleMode; idleSeconds: number | null } | null> {
    return tx.hostedApplication.findUnique({
      where: { id },
      select: { idleMode: true, idleSeconds: true },
    });
  },

  /** Store the application's idle policy (MOTIR-12107). The caller holds the
   *  row's lock; the table's CHECK refuses seconds without `suspend`. */
  async setIdlePolicy(
    id: string,
    policy: { idleMode: HostedIdleMode; idleSeconds: number | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.hostedApplication.update({ where: { id }, data: policy });
  },

  /**
   * The applications the health prober reads (MOTIR-12106): every one with a
   * current release. The caller drops the customer repositories by
   * `isOrganizationSeedSource`; ids only, oldest first, so one run's order is
   * stable.
   */
  async listWithCurrentRelease(
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; seedSource: string }>> {
    const rows = await tx.hostedApplication.findMany({
      where: { currentReleaseId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, projectRepository: { select: { seedSource: true } } },
    });
    return rows.map((r) => ({ id: r.id, seedSource: r.projectRepository.seedSource }));
  },

  /** What the health prober reads of one application and its current release
   *  (MOTIR-12106), or null when it is gone. */
  async findProbeTarget(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationProbeTarget | null> {
    const row = await tx.hostedApplication.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        projectRepositoryId: true,
        target: true,
        productionAddress: true,
        project: { select: { identifier: true } },
        projectRepository: { select: { name: true, seedSource: true } },
        currentRelease: {
          select: {
            id: true,
            state: true,
            commitSha: true,
            providerReleaseId: true,
            providerRef: true,
          },
        },
      },
    });
    if (!row) return null;
    const { project, projectRepository, ...rest } = row;
    return {
      ...rest,
      projectKey: project.identifier,
      repositoryName: projectRepository.name,
      seedSource: projectRepository.seedSource,
    };
  },

  /**
   * What the production usage meter reads of one application, its repository,
   * its organisation's tenant account and its current release (MOTIR-12108), or
   * null when it is gone. Run under the system context: the meter walks every
   * workspace's applications.
   */
  async findMeterTarget(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationMeterTarget | null> {
    const row = await tx.hostedApplication.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        projectRepositoryId: true,
        target: true,
        idleMode: true,
        creditsExhaustedSince: true,
        databaseProjectId: true,
        workspace: {
          select: {
            organizationId: true,
            organization: { select: { hostingTenantAccount: { select: { state: true } } } },
          },
        },
        projectRepository: {
          select: { seedSource: true, hostingSize: true, hostingShape: true },
        },
        currentRelease: {
          select: {
            id: true,
            state: true,
            liveAt: true,
            providerReleaseId: true,
            providerRef: true,
          },
        },
      },
    });
    if (!row) return null;
    const { workspace, projectRepository, ...rest } = row;
    return {
      ...rest,
      organizationId: workspace.organizationId,
      tenantAccountState: workspace.organization.hostingTenantAccount?.state ?? null,
      seedSource: projectRepository.seedSource,
      hostingSize: projectRepository.hostingSize,
      hostingShape: projectRepository.hostingShape,
    };
  },

  /** The meter's application ids: every application ever released, oldest
   *  first — one with no current release may still owe a day's charge. */
  async listMeteredIds(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.hostedApplication.findMany({
      where: { releases: { some: { liveAt: { not: null } } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  /** Record since when the organisation's balance has been below zero on every
   *  one of its applications in `ids` — set on the transition only, so an
   *  existing date is kept — or clear it (`since: null`). Returns the ids whose
   *  value changed. The caller is bound to the applications' workspace. */
  async setCreditsExhaustedSince(
    ids: readonly string[],
    since: Date | null,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const changing = await tx.hostedApplication.findMany({
      where: {
        id: { in: [...ids] },
        creditsExhaustedSince: since === null ? { not: null } : null,
      },
      select: { id: true },
    });
    if (changing.length === 0) return [];
    await tx.hostedApplication.updateMany({
      where: { id: { in: changing.map((c) => c.id) } },
      data: { creditsExhaustedSince: since },
    });
    return changing.map((c) => c.id);
  },

  /** The applications of the organisation's workspaces, with their workspace —
   *  the set a balance reading of that organisation updates. */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    return tx.hostedApplication.findMany({
      where: { workspace: { organizationId } },
      orderBy: { id: 'asc' },
      select: { id: true, workspaceId: true },
    });
  },

  async lockForUpdate(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "hosted_application" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows.length > 0;
  },

  /**
   * Serialize the rollbacks of ONE application (MOTIR-10035): a
   * transaction-scoped advisory lock, released when `tx` ends. Held across the
   * deploy port's rollback, which the row lock must never be.
   */
  async lockRollback(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-application-rollback:${id}`}, 0))`;
  },
};
