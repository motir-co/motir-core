import { randomUUID } from 'node:crypto';
import type { HostedApplicationState, HostingTarget, Prisma } from '@/generated/prisma/client';
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
}

/** The tombstone prefix a released application's slug is rewritten to
 *  (MOTIR-12126). `--` is reserved inside application labels by the address
 *  decision, so the shipped slug derivation can never produce it, and the old
 *  slug is free for another application in the workspace. */
export const RELEASED_SLUG_PREFIX = 'released--';

/** A released application's slug: `released--<id>`. */
export const releasedSlugOf = (id: string) => `${RELEASED_SLUG_PREFIX}${id}`;

/** What a handover state move may set beside the state (MOTIR-12126). */
export interface HostedApplicationStateFields {
  stopsAt?: Date | null;
  handedOverAt?: Date | null;
  handedOverAccountId?: string | null;
}

/** An AWS-target application of an organisation, as the handover reads it. */
export interface HostedApplicationAwsRow {
  id: string;
  workspaceId: string;
  projectId: string;
  projectRepositoryId: string;
  slug: string;
  productionAddress: string | null;
  state: HostedApplicationState;
  upstreamAddress: string | null;
  currentReleaseId: string | null;
}

/** The teardown read of {@link hostedApplicationRepository.findTeardownByProjectRepository}. */
export interface HostedApplicationTeardown {
  id: string;
  projectRepositoryId: string;
  target: HostingTarget;
  state: HostedApplicationState;
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
    state: HostedApplicationState;
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
        state: true,
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
        state: true,
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

  // ── The takeover handover (Story MOTIR-9800 · MOTIR-12126) ────────────────

  /**
   * Move the application's handover state to `to`, ONLY while it is in `from`,
   * setting `fields` beside it. One conditional UPDATE, so a caller is
   * look-before-act without a separate read; returns whether it wrote.
   */
  async setStateIfIn(
    id: string,
    from: readonly HostedApplicationState[],
    to: HostedApplicationState,
    fields: HostedApplicationStateFields,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.hostedApplication.updateMany({
      where: { id, state: { in: [...from] } },
      data: { state: to, ...fields },
    });
    return count === 1;
  },

  /** Record the address an AWS app's own front door answers on without Motir. */
  async setUpstreamAddress(
    id: string,
    upstreamAddress: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.hostedApplication.update({ where: { id }, data: { upstreamAddress } });
  },

  /**
   * Release a KEPT application's addresses when Motir stops serving it (the
   * address decision §3): `productionAddress` cleared and `slug` rewritten to its
   * tombstone, so both are free for another application. The row, its id and its
   * state are kept. The UPDATE matches only while either is still held, so a
   * second call changes nothing; returns whether it wrote.
   */
  async releaseAddresses(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const tombstone = releasedSlugOf(id);
    const { count } = await tx.hostedApplication.updateMany({
      where: { id, OR: [{ productionAddress: { not: null } }, { slug: { not: tombstone } }] },
      data: { productionAddress: null, slug: tombstone },
    });
    return count === 1;
  },

  /** Every `grace` application whose `stopsAt` is at or before `before`, soonest
   *  first — what the stop job walks. */
  async listInGraceStoppingBy(
    before: Date,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; workspaceId: string; stopsAt: Date | null }[]> {
    return tx.hostedApplication.findMany({
      where: { state: 'grace', stopsAt: { lte: before } },
      select: { id: true, workspaceId: true, stopsAt: true },
      orderBy: { stopsAt: 'asc' },
    });
  },

  /**
   * The AWS-target applications of every workspace in the organisation — what
   * the organisation-wide handover moves, read under the system context (the
   * policy's system arm is on USING).
   */
  async listAwsByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationAwsRow[]> {
    return tx.hostedApplication.findMany({
      where: { target: 'aws', workspace: { organizationId } },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        projectRepositoryId: true,
        slug: true,
        productionAddress: true,
        state: true,
        upstreamAddress: true,
        currentReleaseId: true,
      },
      orderBy: { createdAt: 'asc' },
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
