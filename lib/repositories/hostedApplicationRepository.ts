import { randomUUID } from 'node:crypto';
import type { HostingTarget, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import type { HostedApplicationWithReleases } from '@/lib/mappers/hostedApplicationMappers';

// Single-op data access for `hosted_application` — one production home per Motir
// repository row (Story MOTIR-9797 · MOTIR-10026). Writes take a required `tx`;
// the table's `hosted_application_workspace_or_system` policy admits the system
// context the release paths run under and the bound workspace's own session.

const WITH_RELEASES = { currentRelease: true, previousRelease: true } as const;

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
    tx?: Prisma.TransactionClient,
  ): Promise<HostedApplicationWithReleases | null> {
    const client = tx ?? dbRead;
    return client.hostedApplication.findUnique({ where: { id }, include: WITH_RELEASES });
  },

  async findByProjectRepository(
    projectRepositoryId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<HostedApplicationWithReleases | null> {
    const client = tx ?? dbRead;
    return client.hostedApplication.findUnique({
      where: { projectRepositoryId },
      include: WITH_RELEASES,
    });
  },

  async findByProductionAddress(
    productionAddress: string,
    tx?: Prisma.TransactionClient,
  ): Promise<HostedApplicationWithReleases | null> {
    const client = tx ?? dbRead;
    return client.hostedApplication.findUnique({
      where: { productionAddress },
      include: WITH_RELEASES,
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
};
