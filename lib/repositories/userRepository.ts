import { randomUUID } from 'node:crypto';
import { Prisma, type Account, type User } from '@/generated/prisma/client';
import { db, dbRead } from '@/lib/db';

// User repository — single Prisma operations on the `user` table.
// Per CLAUDE.md: write methods require `tx: Prisma.TransactionClient`.
// Reads called outside transactions use the `db` singleton.

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The scrubbed columns {@link userRepository.anonymise} writes — every field on
 * `user` that says something about a PERSON.
 *
 * Spelled out rather than a `Partial<User>` so the set is a reviewable list: a
 * new personal column added to the model and forgotten here is the exact defect
 * MOTIR-3702's explanation names (*"an erasure that quietly skips a table"*),
 * and a named type is what makes the omission visible in a diff.
 */
/** A user row with its CREDENTIAL account rows — at most one, since the read
 *  filters `providerId: 'credential'` and takes 1. Named (MOTIR-4295) so the
 *  shape is derived ONCE here rather than re-inferred at each caller: an
 *  un-annotated read hands every call site the `include` literal to instantiate
 *  for itself, which is the cost `CLAUDE.md`'s repository conventions record. */
export type UserWithCredentialAccount = User & { accounts: Account[] };

export interface AnonymiseUserInput {
  name: string;
  email: string;
  emailVerified: boolean;
  image: null;
  /** The last-active pointer names a project inside somebody's workspace. */
  lastActiveProjectId: null;
  /** An erased account is not platform staff, whatever it was. */
  platformRole: null;
  suspendedAt: null;
  /** Operator prose ABOUT the person — personal data like any other. */
  suspendedReason: null;
}

// ⚠️ `twoFactorEnabled` is NOT in this set, and its absence is deliberate. The
// column has exactly one write — {@link userRepository.setTwoFactorEnabled} —
// and `tests/twoFactorPredicateOneImplementation.test.ts` asserts that no other
// file in `lib/` so much as NAMES it. The erasure clears it by calling that
// method beside its `twoFactorRepository.deleteByUserId`, which is the same
// drop-the-enrolment-and-clear-the-flag-in-one-transaction pair that method was
// written for.

export const userRepository = {
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    const client = tx ?? dbRead;
    return client.user.findUnique({ where: { id } });
  },

  /** The saved interface language column alone (Story MOTIR-7730 · MOTIR-7743) —
   *  read by id with no request in scope. Unvalidated: the service narrows it. */
  async findLocaleById(id: string): Promise<string | null> {
    const row = await dbRead.user.findUnique({ where: { id }, select: { locale: true } });
    return row?.locale ?? null;
  },

  /** The saved interface language of many users at once (Story MOTIR-7732 ·
   *  MOTIR-8104) — ONE query however many ids, so a fan-out sender (every
   *  watcher, every member) resolves its recipients' languages without an N+1.
   *  Every requested id that names a user is a key; an unknown id is absent.
   *  Unvalidated, like `findLocaleById`: the service narrows each value. */
  async findLocalesByIds(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const rows = await dbRead.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, locale: true },
    });
    return new Map(rows.map((r) => [r.id, r.locale]));
  },

  /** The saved interface language of the account holding `email` (Story
   *  MOTIR-7732 · MOTIR-8104), matched case-insensitively the way every address
   *  is stored. `null` when no account has the address; `{ locale: null }` when
   *  one does and has saved no language — the two are different answers. */
  async findLocaleByEmail(email: string): Promise<{ locale: string | null } | null> {
    return dbRead.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { locale: true },
    });
  },

  /**
   * Batch-resolve users by id — the one round-trip the board swimlane
   * projection (Subtask 3.3.4) uses to label assignee lanes (id → name) without
   * an N+1 per lane. Order is unspecified; callers index by `id`. An empty id
   * set short-circuits without a query. Optional `tx` for callers already
   * inside a transaction (watchersService.addWatcher resolves the added
   * target's display fields in the same snapshot the write rode — 5.4.4).
   */
  async findByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<User[]> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    return client.user.findMany({ where: { id: { in: ids } } });
  },

  /**
   * Acquire a row-level lock on the user inside the caller's transaction.
   * Used by ensureDefaultWorkspace to serialize the zero-membership
   * check-then-create: two concurrent first-requests both lock the same
   * user row, so the second blocks until the first commits its membership
   * and then re-reads a non-zero count (no duplicate default workspace).
   * Returns null when the user id doesn't exist. Read-inside-a-transaction
   * → requires `tx` per CLAUDE.md.
   *
   * ⚠️ AND BY `entitlementsService.assertCanCreateOrganization` (MOTIR-3717),
   * for the same reason one axis up: the §4.5 org-creation gate counts the
   * ACTOR's owner/admin orgs, and the window it fails in is the one where that
   * count is ZERO — so there is no organization row to serialize on and this is
   * the row that exists first. The two callers now share an invariant worth
   * naming: **the actor's `user` row is the anchor for any check-then-create
   * whose predicate is empty on the first call.** `user` carries no RLS
   * (`relrowsecurity = false`), so unlike `organization` this lock cannot be
   * filtered out by an UPDATE policy the caller's context does not arm — the
   * failure mode MOTIR-3710 found. That is a schema fact, so the entitlements
   * suite re-measures it rather than trusting this sentence.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "user" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Resolve a user by email. Takes an optional `tx` so the change-email flow can
   * re-read uniqueness INSIDE its transaction (the snapshot that gates the swap);
   * pure read-only callers omit it and use the `db` singleton.
   */
  async findByEmail(email: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    const client = tx ?? dbRead;
    return client.user.findUnique({ where: { email: normalizeEmail(email) } });
  },

  async findByEmailWithCredentialAccount(email: string): Promise<UserWithCredentialAccount | null> {
    return db.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: {
        accounts: {
          where: { providerId: 'credential' },
          take: 1,
        },
      },
    });
  },

  async createWithCredentialAccount(
    data: {
      email: string;
      name: string;
      passwordHash: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    const email = normalizeEmail(data.email);
    // The id is minted HERE, not by the column default, because the credential
    // account must carry it too: better-auth 1.7 finds a credential account by
    // `accountId === userId` (`findCredentialAccount`, and the email sign-in),
    // which is what its own sign-up writes. An account keyed by the email — what
    // this method wrote before 1.7 — signs nobody in (MOTIR-7171).
    const id = randomUUID();
    return tx.user.create({
      data: {
        id,
        email,
        name: data.name,
        emailVerified: false,
        accounts: {
          create: {
            providerId: 'credential',
            accountId: id,
            password: data.passwordHash,
          },
        },
      },
    });
  },

  async createOAuthUser(
    data: {
      email: string;
      name: string;
      image?: string | null;
      providerId: string;
      providerAccountId: string;
      accessToken?: string | null;
      refreshToken?: string | null;
      accessTokenExpiresAt?: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.create({
      data: {
        email: normalizeEmail(data.email),
        name: data.name,
        image: data.image ?? null,
        emailVerified: true,
        accounts: {
          create: {
            providerId: data.providerId,
            accountId: data.providerAccountId,
            accessToken: data.accessToken ?? null,
            refreshToken: data.refreshToken ?? null,
            accessTokenExpiresAt: data.accessTokenExpiresAt ?? null,
          },
        },
      },
    });
  },

  async setEmailVerified(
    id: string,
    verified: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.update({
      where: { id },
      data: { emailVerified: verified },
    });
  },

  /**
   * Swap a user's email (the confirm half of the verified-email-change flow,
   * Subtask 8.8.22). The address has been verified by clicking the emailed link,
   * so `emailVerified` is set true alongside. Can throw `P2002` on the
   * `User.email` unique index if the address was claimed between request and
   * confirm — the service catches it and rethrows `EmailTakenError`.
   */
  async updateEmail(id: string, email: string, tx: Prisma.TransactionClient): Promise<User> {
    return tx.user.update({
      where: { id },
      data: { email: normalizeEmail(email), emailVerified: true },
    });
  },

  /**
   * Update a user's own personal details (Story 8.8 · Subtask 8.8.21) — the
   * write behind the Account › Profile pane. A single Prisma `update`; the
   * caller (`usersService.updateProfile`) owns validation, the transaction, and
   * the old-blob cleanup. Only the keys PRESENT in `data` are written, so the
   * caller updates `name` and `image` independently (and passes `image: null`
   * to remove an avatar). Required `tx` per CLAUDE.md (write method).
   */
  async updateProfile(
    tx: Prisma.TransactionClient,
    id: string,
    data: { name?: string; image?: string | null },
  ): Promise<User> {
    return tx.user.update({ where: { id }, data });
  },

  /**
   * Overwrite the user's GLOBAL last-active project pointer (Subtask 8.8.27) —
   * the landing target on a fresh session/device. A single-row UPDATE keyed by
   * the user's own id: last-writer-wins, no read-then-write, so NO `FOR UPDATE`
   * (concurrent switches just settle on whichever commits last, which is the
   * intended "most recent"). Required `tx` per CLAUDE.md (write method). The
   * `projectId` FK is validated by Postgres; an invalid id raises `P2003`.
   */
  /**
   * Every user whose stored `image` starts with `prefix` (MOTIR-10075), oldest id
   * first — the cutover's stored-reference rewrite counts and rewrites exactly
   * these. `User` carries no RLS, so this reads across tenants under any context.
   */
  async listImagesWithPrefix(
    prefix: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; image: string }>> {
    const rows = await tx.user.findMany({
      where: { image: { startsWith: prefix } },
      select: { id: true, image: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, image: r.image! }));
  },

  /**
   * How many users store an ABSOLUTE `image` (a value with a URI scheme) that
   * does NOT start with `prefix` — a Google-provider avatar is the expected case
   * (MOTIR-10075). The rewrite leaves these alone and reports the count, so an
   * operator sees an own-asset URL on an older host rather than it vanishing
   * silently. Raw SQL for the scheme test, which Prisma's filters cannot express.
   */
  async countAbsoluteImagesNotWithPrefix(
    prefix: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "user"
      WHERE "image" ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
        AND left("image", length(${prefix})) <> ${prefix}`;
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * Compare-and-set one user's `image` (MOTIR-10075): written only while it still
   * holds `from`. Answers how many rows changed — 0 means the row moved since it
   * was read, which the rewrite treats as a refusal rather than an overwrite.
   */
  async compareAndSetImage(
    id: string,
    from: string,
    to: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.user.updateMany({ where: { id, image: from }, data: { image: to } });
    return count;
  },

  /** The saved account language (Story MOTIR-7730 · MOTIR-7747) — one column,
   *  last writer wins. */
  async setLocale(id: string, locale: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.user.update({ where: { id }, data: { locale } });
  },

  async setLastActiveProject(
    id: string,
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.update({ where: { id }, data: { lastActiveProjectId: projectId } });
  },

  /**
   * Flip the two-factor flag (Story MOTIR-1213 · Subtask MOTIR-1218) — the
   * column Better-Auth's `twoFactor` plugin owns, written here only on the ONE
   * path Motir owns end-to-end: `twoFactorService.disable`, which must drop the
   * enrolment row and clear the flag in the SAME transaction or leave an account
   * demanding a second factor it no longer holds.
   *
   * A single-row UPDATE keyed by the user's own id, so no `FOR UPDATE`: the
   * value is not derived from a prior read (`disable` writes a constant
   * `false`), and the enrolment row the operation actually races on is locked by
   * `twoFactorRepository.findByUserIdForUpdate` in the same transaction.
   * Required `tx` per CLAUDE.md (write method).
   */
  async setTwoFactorEnabled(
    id: string,
    enabled: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.update({ where: { id }, data: { twoFactorEnabled: enabled } });
  },

  /**
   * Scrub the personal columns off a profile row — the ANONYMISE half of the
   * erasure sweep (MOTIR-3702), and the one write that makes DECISION 3's
   * *"the name is removed, the row stays"* true.
   *
   * The row is NOT deleted, and `lib/users/accountErasure.ts` carries the whole
   * argument for why: four NOT NULL `onDelete: Restrict` foreign keys onto
   * `user` (`work_item.reporter_id`, `comment.author_id`,
   * `work_item_link.created_by_id`, `work_item_revision.changed_by_id`) make a
   * delete impossible for exactly the population the anonymise group is about.
   *
   * The CALLER computes the scrubbed values (`erasedEmailFor`,
   * `ERASED_USER_NAME`) — this is a single Prisma write with no policy in it,
   * per CLAUDE.md's 4-layer rule. `tx` REQUIRED: it is a write, and it belongs
   * to the erasure's single transaction.
   */
  async anonymise(
    id: string,
    data: AnonymiseUserInput,
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.update({ where: { id }, data });
  },
};
