import { randomUUID } from 'node:crypto';
import { Prisma, type ApiToken } from '@/generated/prisma/client';

/** An `api_token` row with its owning user eager-loaded — the verify lookup's
 * return shape, so the bearer gate resolves token → user in one round-trip. */
export type ApiTokenWithUser = Prisma.ApiTokenGetPayload<{ include: { user: true } }>;

/** {@link ApiTokenWithUser} plus the bound workspace's organization STATE — the
 * verify path's shape, so the bearer gate refuses a suspended organization's
 * tokens (MOTIR-748) in the same query that resolves the token. */
export type ApiTokenWithUserAndOrgState = Prisma.ApiTokenGetPayload<{
  include: {
    user: true;
    workspace: {
      select: { organization: { select: { id: true; name: true; suspendedAt: true } } };
    };
  };
}>;

/** An `api_token` row with its bound workspace + that workspace's organization
 * eager-loaded (bug 7.21) — the list/create return shape, so the DTO can label
 * each token with the org → workspace it belongs to without a second query. */
export type ApiTokenWithScope = Prisma.ApiTokenGetPayload<{
  include: { workspace: { include: { organization: true } }; project: true };
}>;

/** An OAuth connection (MOTIR-6983) with its client and scope — the Connected
 * apps list's row. */
export type OAuthConnectionWithClient = Prisma.ApiTokenGetPayload<{
  include: {
    oauthClient: true;
    workspace: { include: { organization: true } };
    project: true;
  };
}>;

/** The include the list/create reads share to populate {@link ApiTokenWithScope}. */
const SCOPE_INCLUDE = {
  workspace: { include: { organization: true } },
  // The bound project, when there is one (MOTIR-2606). Included here rather
  // than fetched per row by the mapper: the list is the only reader and it
  // needs the NAME, not the id.
  project: true,
} satisfies Prisma.ApiTokenInclude;

const CONNECTION_INCLUDE = {
  ...SCOPE_INCLUDE,
  oauthClient: true,
} satisfies Prisma.ApiTokenInclude;

// API-token repository — single Prisma operations on the `api_token` table
// (Story 7.8 · Subtask 7.8.1). The persistence leaf `apiTokensService` reads
// (the settings list, the verify lookup) and writes (mint, revoke, the
// throttled last-used touch). The SERVICE owns transactions, token
// generation/hashing, validation, the throttle decision, and DTO mapping;
// this leaf holds none of that.
//
// Layer rules (CLAUDE.md): writes (`create`, `revoke`, `touchLastUsed`)
// REQUIRE `tx`; the reads here all run INSIDE a context transaction (the
// settings reads under `withUserContext`, the verify lookup under
// `withSystemContext` — see the service), so they take `tx` too. No business
// logic, no transactions, no DTO mapping.

export interface CreateApiTokenInput {
  userId: string;
  /** The workspace this token is bound to (bug 7.21) — its active workspace at
   * mint time. The verify gate resolves the request workspace from it. */
  workspaceId: string;
  label: string;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date | null;
  /** The token's GRANT — the service resolves it (the caller's choice validated
   * against what they can confer in the bound project, or the fixed device
   * grant) and validates it before it reaches here. */
  scopes: string[];
  /** The PROJECT this token is bound to, or null (MOTIR-2606). Null is the
   * DEVICE-CREDENTIAL SHAPE, not an absent value — see the column's own
   * doc-comment in `prisma/schema.prisma`. */
  projectId: string | null;
  /** The DISPATCH RUN this token is bound to (MOTIR-688) — set only by
   * `runCredentialService.mintRunCredential`. Omitted everywhere else, which
   * leaves the column NULL: an ordinary PAT or device credential. */
  dispatchRunId?: string;
}

export const apiTokenRepository = {
  /** A user's LIVE tokens across ALL their workspaces, newest first — the
   * account-level settings list (bug 7.21: each row carries its bound workspace
   * + org so the list labels it). Runs under `withUserContext`, so RLS already
   * narrows to the owner.
   *
   * ⚠️ The `revokedAt: null` predicate is the LIST half of the same transition
   * guard `verify` carries (MOTIR-3546), and it goes with the column. Revoking
   * deletes the row, so in the steady state no row can match — but the OLD
   * image still stamps `revoked_at` for the length of a rolling release, and
   * without this a user who revoked a token on an old machine and then landed
   * on a new one would see the dead row listed as live. That is the exact
   * defect this card removes, so it must not reappear in the deploy window. */
  async findByUser(userId: string, tx: Prisma.TransactionClient): Promise<ApiTokenWithScope[]> {
    return tx.apiToken.findMany({
      // `dispatchRunId: null` — a RUN token (MOTIR-688) is not a credential the
      // person minted or manages: the run mints it and the run's end deletes it.
      // Listing it would offer a revoke control on something mid-run.
      // `oauthClientId: null` — an OAuth CONNECTION (MOTIR-6983) is managed on
      // Connected apps, not here: it has no secret to show a prefix of, and its
      // revoke also ends the app's session.
      where: { userId, revokedAt: null, dispatchRunId: null, oauthClientId: null },
      orderBy: { createdAt: 'desc' },
      include: SCOPE_INCLUDE,
    });
  },

  /** How many LIVE tokens a user holds — the erasure preview's count
   * (MOTIR-3699), which needs the number and never the rows.
   *
   * ⚠️ THE `revokedAt: null` PREDICATE IS {@link findByUser}'S, and it is copied
   * rather than dropped for the reason that method's own comment gives: during a
   * rolling release the old image still stamps `revoked_at` instead of deleting,
   * so a count without it would tell a reader they are about to lose tokens they
   * already revoked. The count and the list must answer the same question.
   *
   * `tx` REQUIRED: `api_token_owner_or_system` reads `app.user_id`. */
  async countByUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.apiToken.count({
      where: { userId, revokedAt: null, dispatchRunId: null, oauthClientId: null },
    });
  },

  /** The verify lookup — an equality probe on the unique `token_hash` index
   * (constant work regardless of token validity). Runs under
   * `withSystemContext` (pre-auth, no user context yet). */
  async findByTokenHash(
    tokenHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithUserAndOrgState | null> {
    return tx.apiToken.findUnique({
      where: { tokenHash },
      include: {
        user: true,
        workspace: {
          select: { organization: { select: { id: true, name: true, suspendedAt: true } } },
        },
      },
    });
  },

  /** One token by id, scoped to its owner — the revoke ownership probe
   * (cross-user id reads as null → the service's 404-not-403). Includes the
   * bound workspace + org so the revoke response maps the scoped DTO. */
  async findByIdForUser(
    tokenId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithScope | null> {
    // An OAuth connection is not a token the PAT surface manages (MOTIR-6983);
    // it reads as missing here, and Connected apps revokes it.
    return tx.apiToken.findFirst({
      where: { id: tokenId, userId, oauthClientId: null },
      include: SCOPE_INCLUDE,
    });
  },

  /** Persist a freshly-minted token's hash row, returning it with its bound
   * workspace + org so the service maps the scoped DTO. Required `tx`. */
  async create(
    input: CreateApiTokenInput,
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithScope> {
    return tx.apiToken.create({ data: input, include: SCOPE_INCLUDE });
  },

  /** Replace a token's GRANT and nothing else (MOTIR-10188) — the `scopes`
   * column only, so the hash, prefix, label, binding and expiry stay exactly as
   * they were minted. The service has already proven ownership and validated the
   * grant; this leaf writes what it is handed. Returns the row with its scope
   * include so the service maps the same DTO the list renders. Required `tx`:
   * `api_token_owner_or_system` reads `app.user_id`. */
  async updateScopes(
    tokenId: string,
    scopes: string[],
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithScope> {
    return tx.apiToken.update({ where: { id: tokenId }, data: { scopes }, include: SCOPE_INCLUDE });
  },

  /** Revoke: DELETE the row (MOTIR-3546). Also the OAuth connection's revoke
   * (MOTIR-6983), whose access tokens, refresh tokens and consent cascade with it.
   * Revocation used to stamp `revokedAt`
   * and leave the row "for the audit trail" — a trail nothing ever read, on the
   * one surface whose job is to answer *which of my credentials are live*. The
   * credential list now holds only live credentials, which is what this
   * surface's own mirror does (`design/settings/design-notes.md`).
   *
   * Deleting is safe here and was checked before it was chosen: the only tables
   * that reference `api_token` are the OAuth provider's (MOTIR-6983), and they
   * CASCADE — a deleted connection is meant to take its tokens. And the RLS
   * policy `api_token_owner_or_system` is `FOR ALL`, so an owner DELETE is
   * already permitted without a policy change. Required `tx`. */
  async remove(tokenId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.apiToken.delete({ where: { id: tokenId } });
  },

  /** Delete every token bound to one dispatch run — the run credential's revoke
   * (MOTIR-688). Deleting is revocation here exactly as in {@link remove}, and it
   * is IDEMPOTENT by construction: a second call finds nothing and returns 0.
   * Runs under `withSystemContext` (the end path has no dispatcher user
   * context), which `api_token_owner_or_system` admits. Required `tx`. */
  async deleteByDispatchRunId(
    dispatchRunId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.apiToken.deleteMany({ where: { dispatchRunId } });
    return count;
  },

  /**
   * Record an OAuth CONNECTION (MOTIR-6983) — or, when this person already has
   * one for this client in this workspace and project, REPLACE its grant and
   * label and return it. One statement, `INSERT … ON CONFLICT` against the
   * hand-written `api_token_oauth_connection_key` index, so two approvals racing
   * for the same (person, client, workspace, project) leave ONE row: the loser's
   * insert becomes an update of the winner's, and both get its id back.
   *
   * `inserted` says which happened (`xmax = 0` is true only for a row this
   * statement created), so a caller can undo exactly what it created and never a
   * connection someone approved earlier.
   *
   * Raw SQL because Prisma's `upsert` needs a unique it can name, and this one is
   * an expression index behind a predicate. Required `tx`: `api_token` RLS reads
   * `app.user_id`, which the caller's user context binds.
   */
  async upsertOAuthConnection(
    input: {
      userId: string;
      workspaceId: string;
      projectId: string | null;
      oauthClientId: string;
      label: string;
      tokenHash: string;
      tokenPrefix: string;
      scopes: string[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; inserted: boolean }> {
    const rows = await tx.$queryRaw<{ id: string; inserted: boolean }[]>`
      INSERT INTO "api_token"
        ("id", "user_id", "workspace_id", "project_id", "oauth_client_id", "label",
         "token_hash", "token_prefix", "scopes", "created_at")
      VALUES
        (${randomUUID()}, ${input.userId}, ${input.workspaceId}, ${input.projectId},
         ${input.oauthClientId}, ${input.label}, ${input.tokenHash}, ${input.tokenPrefix},
         ${input.scopes}::text[], NOW())
      ON CONFLICT ("user_id", "oauth_client_id", "workspace_id", COALESCE("project_id", ''))
        WHERE "oauth_client_id" IS NOT NULL
      DO UPDATE SET "scopes" = EXCLUDED."scopes", "label" = EXCLUDED."label"
      RETURNING "id", (xmax = 0) AS "inserted"`;
    return rows[0]!;
  },

  /** A person's OAuth connections, newest first, with the client, the bound
   * workspace + org and the project — the Connected apps list (MOTIR-6983).
   * `tx` REQUIRED: RLS narrows to the owner under `withUserContext`. */
  async findOAuthConnectionsByUser(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OAuthConnectionWithClient[]> {
    return tx.apiToken.findMany({
      where: { userId, oauthClientId: { not: null } },
      orderBy: { createdAt: 'desc' },
      include: CONNECTION_INCLUDE,
    });
  },

  /** One OAuth connection by id, scoped to its owner — the revoke ownership probe
   * (a cross-user id, or a PAT's id, reads as null → the service's 404). */
  async findOAuthConnectionForUser(
    connectionId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApiToken | null> {
    return tx.apiToken.findFirst({
      where: { id: connectionId, userId, oauthClientId: { not: null } },
    });
  },

  /**
   * Stamp `lastUsedAt` — the throttled verify touch. Required `tx`. Returns how
   * many rows it touched: 0 means a revoke deleted the token since the caller read
   * it, which `update` would have raised as P2025 (MOTIR-8885).
   */
  async touchLastUsed(
    tokenId: string,
    lastUsedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.apiToken.updateMany({ where: { id: tokenId }, data: { lastUsedAt } });
    return r.count;
  },

  /**
   * Delete every personal access token this user holds — the erasure sweep's
   * DELETE group (MOTIR-3702). The bulk twin of {@link remove}, and safe for the
   * same two reasons it is: the only references to `api_token` are the OAuth
   * provider's, which CASCADE (MOTIR-6983 — the person's connected apps go with
   * their tokens), and `api_token_owner_or_system` is `FOR ALL`, so
   * the owner binding the erasure already holds admits the DELETE.
   *
   * A live bearer credential outlasting the account it authenticates is the
   * failure this closes: nothing else in the erasure would revoke it, and the
   * MCP surface it opens does not consult `user.email`.
   */
  async deleteAllForUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.apiToken.deleteMany({ where: { userId } });
    return count;
  },
};
