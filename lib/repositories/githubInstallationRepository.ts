import { type GithubInstallation, type Prisma } from '@/generated/prisma/client';

// GitHub-installation repository — single Prisma operations on the
// `github_installation` table (Story 7.10 · MOTIR-891). The service
// (githubInstallationService) owns orchestration, transactions, and DTO mapping;
// this leaf holds none of that.
//
// Layer rules (CLAUDE.md): the write (`upsert`) REQUIRES `tx`. The reads take
// `tx` too — both run inside a context transaction (`withWorkspaceContext` for
// the settings read, `withSystemContext` for the webhook write path), so RLS
// scopes them.

export interface UpsertGithubInstallationInput {
  installationId: string;
  /** The workspace whose OWN grant this is, or NULL for Motir's shared
   *  provisioning installation (MOTIR-1931), which is owned by no tenant — its
   *  repos carry their own `workspace_id`. Widened here so the substrate can
   *  EXPRESS the shared row; note that `githubInstallationService.persistInstallation`
   *  still requires a `workspaceId: string`, which is what keeps the destructive
   *  reconcile (`deleteExcept`) unreachable on the shared path. */
  workspaceId: string | null;
  /** The ORGANISATION this connection belongs to (MOTIR-4649), or NULL for the
   *  same row `workspaceId` is null for — Motir's shared provisioning
   *  installation, which is owned by no tenant and can name neither tier.
   *  Nullable in the TYPE as well as the column, so the one row that legitimately
   *  has no organisation is expressible rather than fudged. */
  organizationId: string | null;
  accountLogin: string;
  accountType: string;
}

/** A GitLab connection upsert (Story 7.23 · MOTIR-1474) — the SAME table under
 *  `provider: 'gitlab'`, plus the encrypted token set GitLab's OAuth model stores
 *  (GitHub leaves these null). */
export interface UpsertGitlabConnectionInput {
  installationId: string;
  workspaceId: string;
  /** The owning ORGANISATION (MOTIR-4649). Required here — a GitLab connection is
   *  always a tenant's own grant, so there is no shared-installation case. */
  organizationId: string;
  accountLogin: string;
  accountType: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
}

export const githubInstallationRepository = {
  /** The workspace's GitHub installation, or null when it has none (a valid
   *  "not connected" state — the two grants are independent). Filtered to
   *  `provider: 'github'` so a GitLab connection on the same workspace (same
   *  table, MOTIR-1474) never leaks into a GitHub read. */
  async findByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findFirst({ where: { workspaceId, provider: 'github' } });
  },

  /**
   * The ORGANISATION's GitHub installations — the tier a connection is actually
   * owned at after MOTIR-4649, and the read `findByWorkspaceId` above cannot
   * stand in for (MOTIR-4836). A workspace's own grant matches `workspace_id`;
   * a SIBLING workspace of the same organisation matches nothing, so an
   * organisation-tier surface asking the workspace question is told its
   * organisation has no connection while its repositories are right there.
   *
   * ⚠️ IT RETURNS A LIST, AND THAT IS THE DISPOSITION RATHER THAN AN OVERSIGHT.
   * Nothing forbids two workspaces of one organisation each installing the App
   * on a DIFFERENT GitHub account, so N is genuinely reachable — and the honest
   * answer to "which one is the organisation's connection?" is then all of
   * them. Picking `rows[0]` would be a guess wearing a singular return type;
   * `organizationRepoService.listRepositoryUsage` is the precedent for handing
   * the set to the caller instead.
   *
   * ORDERED DETERMINISTICALLY (`created_at`, then `id`) and carrying NO
   * preference: the oldest connection is not the "real" one, it is merely
   * first, and a stable order is what keeps a render from reshuffling between
   * two reads of the same page.
   *
   * Filtered to `provider: 'github'` for the same reason `findByWorkspaceId` is
   * — a GitLab connection lives in this table too (MOTIR-1474).
   *
   * The caller must have bound `app.organization_id` (or a workspace whose
   * organisation this is): `github_installation_org_read` is a FOR SELECT arm,
   * and without a binding this read is refused rather than wrong.
   */
  async listByOrganizationId(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation[]> {
    return tx.githubInstallation.findMany({
      where: { organizationId, provider: 'github' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** EVERY connection the organization owns, GitHub and GitLab alike — the
   *  organization Git offboarding's read (MOTIR-6397). {@link listByOrganizationId}
   *  is GitHub-only on purpose (the inventory's), so this is its own method. */
  async listAllProvidersByOrganizationId(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation[]> {
    return tx.githubInstallation.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Hand an installation to another organization — the offboarding's UNLINK of a
   *  shared installation (MOTIR-6397): the org being erased stops owning it, the
   *  org still using it takes it over, and nothing on GitHub changes. */
  async setOrganizationId(
    id: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.githubInstallation.update({ where: { id }, data: { organizationId } });
  },

  /** Re-stamp the legacy tenancy columns onto another LINKED organisation — the
   *  per-organisation disconnect (MOTIR-8222) when the organisation leaving is
   *  the one the row was stamped with and another stays linked, so the leaving
   *  organisation stops seeing the installation through `findByWorkspaceId` /
   *  `listByOrganizationId`. */
  async restampTenancy(
    id: string,
    workspaceId: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.githubInstallation.update({ where: { id }, data: { workspaceId, organizationId } });
  },

  /** The workspace's connection for a specific provider (`github` | `gitlab`), or
   *  null. The provider-aware read a GitLab caller uses. */
  async findByWorkspaceAndProvider(
    workspaceId: string,
    provider: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findFirst({ where: { workspaceId, provider } });
  },

  /** Look up by GitHub's numeric installation id (the webhook's key). The row's
   *  `workspaceId` is NULL for Motir's shared provisioning installation, so a
   *  caller must NOT read it to route, attribute, or authenticate — the delivery's
   *  repo row answers that (MOTIR-1931). This read still SELECTS which mirror rows
   *  a delivery may touch. */
  async findByInstallationId(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findUnique({ where: { installationId } });
  },

  /**
   * GitHub's numeric installation id for each of these rows, keyed by the row's
   * own `id` (MOTIR-10062) — the resolve an outbound call owes before it mints a
   * token for a mirror row's repository.
   *
   * ⚠️ `GithubRepo.installationId` is the foreign key to THIS table's `id`, a cuid
   * GitHub has never issued; `POST /app/installations/<cuid>/access_tokens` is a
   * 404. The id GitHub knows is the row's `installationId` column, so a caller
   * holding the foreign key resolves it here. Run it under `withSystemContext`:
   * Motir's shared provisioning installation has a NULL `workspace_id`, so a
   * tenant context reads zero rows for it and raises nothing. An id with no row
   * is simply absent from the map.
   */
  async findHostInstallationIdsByIds(
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, string>> {
    const rows = await tx.githubInstallation.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, installationId: true },
    });
    return new Map(rows.map((row) => [row.id, row.installationId]));
  },

  /**
   * Whether the App is installed on a given ACCOUNT — the takeover's completion
   * probe (MOTIR-711): after a repository has moved to the user's own GitHub,
   * this answering non-null is what proves the loop survived the handoff.
   *
   * Matched case-INSENSITIVELY because GitHub logins are, and the login being
   * compared arrives from three different places (the user's stored identity, the
   * `repository` webhook's payload, and whatever the requester typed) which need
   * not agree on casing. `mode: 'insensitive'` costs an index here, which is
   * acceptable: this runs once per takeover completion check, over a table with
   * one row per installation — never in a hot path.
   */
  async findByAccountLogin(
    accountLogin: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findFirst({
      where: { accountLogin: { equals: accountLogin, mode: 'insensitive' } },
    });
  },

  /** Create-or-refresh the installation, keyed on the unique GitHub
   *  `installation_id` (a re-install / repo-selection change refreshes in place). */
  async upsert(
    input: UpsertGithubInstallationInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation> {
    const { installationId, ...rest } = input;
    return tx.githubInstallation.upsert({
      where: { installationId },
      create: { installationId, ...rest },
      update: rest,
    });
  },

  /**
   * Create-or-refresh an installation WITHOUT touching its tenancy (Story
   * MOTIR-8216 · MOTIR-8219). One GitHub account's installation can now serve
   * several organisations, each through its own `github_installation_org_link`
   * row, so a second organisation linking it must not re-stamp the first's
   * `workspace_id` / `organization_id`. Those are written on CREATE only; an
   * update refreshes the account's login and type and nothing else. `upsert`
   * above is unchanged, for the shared provisioning installation.
   */
  async upsertPreservingTenancy(
    input: UpsertGithubInstallationInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation> {
    const { installationId, accountLogin, accountType } = input;
    return tx.githubInstallation.upsert({
      where: { installationId },
      create: input,
      update: { accountLogin, accountType },
    });
  },

  /** Remove an installation by its GitHub `installation_id` (the `installation
   *  deleted` webhook — an uninstall). `deleteMany` (not `delete`) so a redelivery
   *  of the uninstall event after the row is gone is an idempotent no-op (count 0)
   *  rather than a `P2025` throw. The `github_repo` / `github_pull_request` rows
   *  cascade with it (the FK `onDelete: Cascade`). Returns the delete count. */
  async deleteByInstallationId(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubInstallation.deleteMany({ where: { installationId } });
    return result.count;
  },

  /** Create-or-refresh a GitLab connection (Story 7.23 · MOTIR-1474), keyed on the
   *  unique `installation_id` (the minted connection id). Re-connecting the same
   *  connection refreshes the account + token set in place. `provider` is pinned
   *  to `'gitlab'`; the encrypted token columns GitHub leaves null are populated. */
  async upsertGitlabConnection(
    input: UpsertGitlabConnectionInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation> {
    const { installationId, ...rest } = input;
    return tx.githubInstallation.upsert({
      where: { installationId },
      create: { installationId, provider: 'gitlab', ...rest },
      update: { provider: 'gitlab', ...rest },
    });
  },

  /** Lock a connection row FOR UPDATE by its `installation_id` (Story 7.23 ·
   *  MOTIR-1474) — the read that guards the token refresh. GitLab rotates the
   *  refresh token on every refresh, so concurrent mint calls MUST serialize on
   *  this lock or a double-refresh invalidates the newer token. The caller
   *  re-reads via `findByInstallationId` inside the SAME transaction. */
  async lockByInstallationId(installationId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT id FROM github_installation WHERE installation_id = ${installationId} FOR UPDATE`;
  },

  /** Persist a rotated token set on a connection (Story 7.23 · MOTIR-1474), after
   *  a refresh under the FOR UPDATE lock above. */
  async updateTokens(
    id: string,
    tokens: { accessTokenEncrypted: string; refreshTokenEncrypted: string; tokenExpiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation> {
    return tx.githubInstallation.update({ where: { id }, data: tokens });
  },
};
