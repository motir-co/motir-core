import { Prisma, type GithubIdentity } from '@/generated/prisma/client';

// GitHub-identity repository — single Prisma operations on the `github_identity`
// table (Story 7.10 · MOTIR-1498). The service (githubIdentityService) owns the
// OAuth orchestration, token encryption, the transaction, and DTO mapping; this
// leaf holds none of that.
//
// Layer rules (CLAUDE.md): the write (`upsertForUser`) REQUIRES `tx` — it runs
// inside the callback's `withUserContext` transaction, so RLS binds the identity
// to the acting user. The plain read (`findByUserId`) is used by the settings
// read path; it runs under `withUserContext` too (so RLS narrows to the owner),
// hence it takes `tx`.

export interface UpsertGithubIdentityInput {
  userId: string;
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
  accessTokenEncrypted: string;
  /** Absent / null when GitHub issued a non-expiring token (no refresh token):
   *  the upsert then stores null, so a reconnect never keeps a stale one. */
  refreshTokenEncrypted?: string | null;
  tokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
}

/** A renewed token pair, as `storeRefreshedTokens` writes it. */
export interface RefreshedGithubTokens {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
}

export const githubIdentityRepository = {
  /** The acting user's GitHub identity, or null if unbound (the valid
   *  "identity with no installation / no identity yet" state the UI shows).
   *  Runs under `withUserContext`, so RLS already narrows to the owner. */
  async findByUserId(userId: string, tx: Prisma.TransactionClient): Promise<GithubIdentity | null> {
    return tx.githubIdentity.findUnique({ where: { userId } });
  },

  /**
   * The connected GitHub logins for MANY users, keyed by `userId` (MOTIR-1910).
   *
   * The team code-access read asks "which of these N members has an account Motir
   * can invite?", and asking it one member at a time is N round-trips to build one
   * table. Selects only the two columns that answer it — never the encrypted
   * token, which nothing outside `githubIdentityService` may read.
   *
   * A member with no identity is simply ABSENT from the result, which is the
   * honest shape: the caller renders that as "no connected GitHub account", the
   * one state only that member can resolve.
   */
  async findLoginsByUserIds(
    userIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Pick<GithubIdentity, 'userId' | 'githubLogin'>[]> {
    if (userIds.length === 0) return [];
    return tx.githubIdentity.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, githubLogin: true },
    });
  },

  /** Resolve a GitHub user (by their numeric GitHub user id, `@unique`) to the
   *  bound Motir identity — the REVERSE of `findByUserId`, needed by the webhook
   *  status sync (MOTIR-892) to attribute a PR-driven transition to the PR
   *  author's Motir user where they've connected their identity. Null when the
   *  GitHub user has no binding (the transition falls back to a system actor). */
  async findByGithubUserId(
    githubUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubIdentity | null> {
    return tx.githubIdentity.findUnique({ where: { githubUserId } });
  },

  /** Create-or-refresh the acting user's identity binding (re-auth updates the
   *  login / avatar / tokens in place, keyed on the unique `user_id`). A re-auth
   *  is a fresh credential, so it also clears a refused-refresh mark and any
   *  renewal lease (Bug MOTIR-10021). */
  async upsertForUser(
    input: UpsertGithubIdentityInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubIdentity> {
    const { userId, ...given } = input;
    const rest = {
      ...given,
      refreshTokenEncrypted: given.refreshTokenEncrypted ?? null,
      tokenExpiresAt: given.tokenExpiresAt ?? null,
      refreshTokenExpiresAt: given.refreshTokenExpiresAt ?? null,
    };
    return tx.githubIdentity.upsert({
      where: { userId },
      create: { userId, ...rest },
      update: { ...rest, refreshLeaseUntil: null, refreshRefusedAt: null },
    });
  },

  /** Row-lock the user's identity for the renewal decision (Bug MOTIR-10021).
   *  `$queryRaw` because Prisma has no `FOR UPDATE`. Held only for the short
   *  decide transaction, never across the call to GitHub. */
  async lockByUserId(userId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "github_identity" WHERE "user_id" = ${userId} FOR UPDATE`;
  },

  /** Take the single-flight renewal lease until `until`. Written under the lock
   *  above, and committed BEFORE the refresh grant is spent. */
  async setRefreshLease(id: string, until: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.githubIdentity.update({ where: { id }, data: { refreshLeaseUntil: until } });
  },

  /** Give the lease back without changing the stored pair (a renewal that got
   *  no answer, or a 5xx). */
  async releaseRefreshLease(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.githubIdentity.update({ where: { id }, data: { refreshLeaseUntil: null } });
  },

  /** Store the rotated pair and release the lease, in one statement. */
  async storeRefreshedTokens(
    id: string,
    tokens: RefreshedGithubTokens,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.githubIdentity.update({
      where: { id },
      data: { ...tokens, refreshLeaseUntil: null },
    });
  },

  /** Mark the refresh token REFUSED by GitHub and release the lease. The
   *  identity is dead until the member reconnects (`upsertForUser` clears it). */
  async markRefreshRefused(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.githubIdentity.update({
      where: { id },
      data: { refreshRefusedAt: at, refreshLeaseUntil: null },
    });
  },

  /** Remove the acting user's identity binding (Disconnect — MOTIR-895).
   *  Runs inside the disconnect `withUserContext` transaction, so RLS narrows to
   *  the owner. Returns the delete count (0 when already unbound — idempotent). */
  async deleteByUserId(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.githubIdentity.deleteMany({ where: { userId } });
    return r.count;
  },
};
