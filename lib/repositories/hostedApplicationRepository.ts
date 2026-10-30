import { randomUUID } from 'node:crypto';
import type { HostingTarget, Prisma } from '@/generated/prisma/client';
import type { HostedApplicationWithReleases } from '@/lib/mappers/hostedApplicationMappers';

// Single-op data access for `hosted_application` — one production home per Motir
// repository row (Story MOTIR-9797 · MOTIR-10026). Reads and writes take a required `tx`;
// the table's `hosted_application_workspace_or_system` policy admits the system
// context the release paths run under and the bound workspace's own session.

/** Who restored a release, for its DTO (MOTIR-10035). */
const RESTORED_BY = { restoredBy: { select: { id: true, name: true } } } as const;
const WITH_RELEASES = {
  currentRelease: { include: RESTORED_BY },
  previousRelease: { include: RESTORED_BY },
} as const;
/** The default reads never select the database URL's ciphertext: only
 *  `findDatabaseById` does, for the production database service (MOTIR-10028). */
const WITHOUT_SECRET = { databaseUrlCiphertext: true } as const;

/** What the production database service reads of an application. */
export interface HostedApplicationDatabaseRow {
  id: string;
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
  } | null> {
    return tx.hostedApplication.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        slug: true,
        target: true,
        productionAppName: true,
        currentReleaseId: true,
      },
    });
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
        "slug", "production_address", "created_at", "updated_at"
      )
      VALUES (
        ${randomUUID()}, ${input.workspaceId}, ${input.projectId},
        ${input.projectRepositoryId}, ${input.target}::"hosting_target", ${input.slug},
        ${input.productionAddress}, NOW(), NOW()
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
