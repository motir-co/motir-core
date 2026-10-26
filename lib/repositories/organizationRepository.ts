import { type Organization, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { bindOrganizationContext } from '@/lib/organizations/context';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import type { Locale } from '@/lib/i18n/locales';

// Organization repository — single Prisma operations on the `organization`
// table (the root tenancy tier, Story 6.10). The org-scoped business logic
// (CRUD orchestration, the access gate, the signup auto-provision, the
// cross-workspace member roster) lives in `organizationsService` (6.10.4); this
// file is data access only — each method is one Prisma call, writes require
// `tx`. Mirrors `workspaceRepository`.

/** The signals `pmTierForOrg` (8.1.11) resolves an org's §4 tier from: the
 *  `isMeta` exemption flag, the scaled-tracker (purchased-seat) subscription, and
 *  the `aiIncludedSeat` flag (a PAID AI plan bundles a seat → lifts caps, 8.1.24). */
export interface OrgCapContext {
  isMeta: boolean;
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
  aiIncludedSeat: boolean;
}

/** Normalise a selected org row (or a missing/hidden one) into an `OrgCapContext`.
 *  Absent → the safe default (`isMeta: false`, no subscription, no AI seat → bounded `free`). */
function toCapContext(
  org: {
    isMeta: boolean;
    scaledTrackerSubscription: Prisma.JsonValue;
    aiIncludedSeat: boolean;
  } | null,
): OrgCapContext {
  return {
    isMeta: org?.isMeta ?? false,
    scaledTrackerSubscription:
      (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null,
    aiIncludedSeat: org?.aiIncludedSeat ?? false,
  };
}

export const organizationRepository = {
  /**
   * Find by id inside the caller's transaction so the organization RLS policy
   * (which keys off the per-transaction `app.organization_id` / `app.user_id`
   * GUCs bound by the 6.10.4 org-context layer) admits the row under the
   * non-bypass `motir_app` role. Used by role-gated reads that guard a
   * subsequent write.
   *
   * There is no `db`-singleton variant any more (MOTIR-2775). One existed, returned
   * NULL under RLS by design, had ZERO production callers, and survived only on the
   * tests that asserted it — a method that cannot work is a trap in proportion to how
   * inviting its name is, and `findById` is about as inviting as a name gets.
   */
  async findByIdInTx(id: string, tx: Prisma.TransactionClient): Promise<Organization | null> {
    return tx.organization.findUnique({ where: { id } });
  },

  /**
   * When organization `id` started CLOSING, or null when it is not closing
   * (MOTIR-6396) — the org-tier write guard's read (`lib/organizations/closingGuard.ts`).
   * Takes `tx`: it guards a write, and the caller's context admits the row.
   */
  async findClosingSinceById(id: string, tx: Prisma.TransactionClient): Promise<Date | null> {
    const row = await tx.organization.findUnique({ where: { id }, select: { closingSince: true } });
    return row?.closingSince ?? null;
  },

  /**
   * The CLOSING organization that owns `workspaceId`, or null when that org is
   * open (MOTIR-6396) — the workspace-addressed twin of {@link findClosingSinceById},
   * returning the org id the refusal names.
   */
  async findClosingByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ organizationId: string } | null> {
    const rows = await tx.$queryRaw<Array<{ organizationId: string }>>`
      SELECT o."id" AS "organizationId"
      FROM "workspace" w
      JOIN "organization" o ON o."id" = w."organizationId"
      WHERE w."id" = ${workspaceId}
        AND o."closing_since" IS NOT NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  },

  /**
   * The NAME of the closing organization that owns `workspaceId`, or null when it
   * is open (Story MOTIR-6306 · MOTIR-6403) — the read-only note a page header
   * shows while the org closes.
   */
  async findClosingNameByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ name: string }>>`
      SELECT o."name" AS "name"
      FROM "workspace" w
      JOIN "organization" o ON o."id" = w."organizationId"
      WHERE w."id" = ${workspaceId}
        AND o."closing_since" IS NOT NULL
        AND o."erased_at" IS NULL
      LIMIT 1
    `;
    return rows[0]?.name ?? null;
  },

  /**
   * When the organization that owns `workspaceId` started CLOSING, or null when it
   * is not closing (Story MOTIR-6306 · MOTIR-6396) — the one read the permission
   * resolution adds, so that every actor in every workspace of a closing org
   * resolves to read-only.
   *
   * Through the workspace, in ONE statement, because the resolver is handed a
   * workspace and never an org. Takes `tx`: both rows are RLS-gated, and the
   * caller's transaction is the one binding the GUCs that admit them — a workspace
   * member is always an org member (`organization-tier.md`, the upward invariant),
   * so `organization_membership_visible` admits the org; an unbound public read is
   * admitted by `organization_public_project_read`. A row that is not visible
   * reads as not closing — the answer for a workspace the caller cannot see is
   * decided by the gates around this read, not by it. `tx` is optional ONLY for
   * that unbound public path (`dbRead`, the MOTIR-4295 rule).
   */
  async findClosingSinceByWorkspaceId(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ closingSince: Date | null }>>`
      SELECT o."closing_since" AS "closingSince"
      FROM "workspace" w
      JOIN "organization" o ON o."id" = w."organizationId"
      WHERE w."id" = ${workspaceId}
      LIMIT 1
    `;
    return rows[0]?.closingSince ?? null;
  },

  /**
   * The content language of the organisation that owns `workspaceId` (Story
   * MOTIR-7731 · MOTIR-8096) — the language a work-text write records when its
   * caller names none. Read inside the write's own transaction, under the
   * workspace context it already holds, so the recorded language and the write
   * cannot disagree. NULL for a workspace the transaction is not bound to.
   */
  async findContentLanguageByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    // Through `app_workspace_content_language` (MOTIR-8097), not a join: the org
    // row is invisible to a workspace writer that is not an org member — the
    // system principal — and the function reads it for the BOUND workspace only.
    const rows = await tx.$queryRaw<Array<{ contentLanguage: string | null }>>`
      SELECT app_workspace_content_language(${workspaceId}) AS "contentLanguage"
    `;
    return rows[0]?.contentLanguage ?? null;
  },

  /**
   * Of the organisation ids given, which still have a row — the liveness read
   * motir-ai's code-graph reconciler subtracts from its own bucket enumeration
   * (MOTIR-4647). Answers about the ids it is GIVEN and never enumerates, so a
   * leak can never be larger than what the caller already knew.
   *
   * ⚠️ NO HOP TO A CHILD ROW, and that is the substantive difference from
   * `projectRepository.findLivePairs`. That read asserts the project's workspace
   * still exists, because a project without one is not a live tenancy. An
   * organisation is the ROOT tier: it is live because its own row is there, and
   * an org with zero workspaces and zero projects is a live org that has not
   * been used yet. Joining anything here would report a real customer `absent`
   * and delete their graphs.
   *
   * ⚠️ `tx` IS REQUIRED, AND REQUIRED IS THE SAFETY PROPERTY — not a layering
   * formality. `organization` is RLS-protected and the only arm that admits a
   * cross-tenant read is `organization_system_read`
   * (`20260817120000_system_admin_read_arms_workspace_organization`), which reads
   * the `app.system_admin` GUC bound by `withSystemContext` for the life of ONE
   * transaction. Called on the `db` singleton this method would return ZERO ROWS
   * AND RAISE NOTHING — every organisation reported `absent`, which is the
   * delete-everything answer. That migration exists because the project-shaped
   * read had exactly this bug; taking a required `tx` makes it unreachable here
   * rather than merely documented.
   */
  async findLiveIds(ids: string[], tx: Prisma.TransactionClient): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.organization.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * The organisations that can be on the Host plan (MOTIR-9582): those holding a
   * PAID AI plan (`aiIncludedSeat`, the local mirror of motir-ai's plan tier),
   * not Motir's own (`isMeta` / `internalBilling` are never on Host) and not
   * closing. A candidate list only — the reconcile confirms each with the plan
   * read. Takes `tx`: a cross-org read admitted only by the system context.
   */
  async listHostCandidateIdsInTx(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.organization.findMany({
      where: { aiIncludedSeat: true, isMeta: false, internalBilling: false, closingSince: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.id);
  },

  async create(
    data: {
      name: string;
      slug: string;
      /** The language new work is written in (MOTIR-8093); omitted keeps the column default `en`. */
      contentLanguage?: Locale;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.create({ data });
  },

  async update(
    id: string,
    data: {
      name?: string;
      slug?: string;
      isMeta?: boolean;
      /** The org-tier require-2FA policy (Story MOTIR-1215 · MOTIR-3644). */
      requiresTwoFactor?: boolean;
      /** Set when a deletion is scheduled, cleared by a cancel (MOTIR-6399). */
      closingSince?: Date | null;
      /** Written only by `organizationContentLanguageService` (MOTIR-8094). */
      contentLanguage?: Locale;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({ where: { id }, data });
  },

  /**
   * Scrub the organization to its TOMBSTONE (Story MOTIR-6306 · MOTIR-6400;
   * `organization-deletion.md` §6.4): the erased label, a random slug, `erasedAt`
   * set, `closingSince` cleared, and every flag it carried reset. The row itself
   * stays: it is what the seven-year billing record (`CiPeriodCharge`) hangs off.
   * Requires `app.organization_id` bound (`organization_mutate_active`).
   */
  async scrubToTombstone(
    id: string,
    data: { name: string; slug: string; erasedAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.organization.update({
      where: { id },
      data: {
        name: data.name,
        slug: data.slug,
        erasedAt: data.erasedAt,
        closingSince: null,
        requiresTwoFactor: false,
        isMeta: false,
        internalBilling: false,
        aiIncludedSeat: false,
        scaledTrackerSubscription: Prisma.DbNull,
      },
    });
  },

  /**
   * Delete an erased organization's TOMBSTONE row — the retention purge's
   * (Story MOTIR-6306 · MOTIR-6401), seven years after the erasure. Its billing
   * rows (`CiPeriodCharge`) cascade with it; the caller has already removed the
   * deletion requests, whose FK is `Restrict`. Requires `app.organization_id`
   * bound. Returns whether a row was deleted.
   */
  async deleteErasedById(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.organization.deleteMany({ where: { id, erasedAt: { not: null } } });
    return result.count > 0;
  },

  /**
   * Row-lock the organization `FOR UPDATE` inside the caller's transaction — the
   * serialization anchor for the §4 count-guarded creates (8.1.11). The work-item
   * / project / workspace caps read a count then create; without a shared lock
   * two concurrent creates both observe `count = limit - 1`, both pass, and both
   * insert (a warm-pool TOCTOU overage — CLAUDE.md § lock-before-read-derived).
   * Locking the single org row serializes every create under the org: the second
   * racer blocks until the first commits, then re-counts and correctly sees the
   * limit. Returns whether a row was actually LOCKED — `false` means the caller
   * is NOT serialized and must refuse rather than proceed (see
   * `entitlementsService`'s `lockOrgRowOrRefuse`).
   * `tx` REQUIRED — a row lock lives only for its transaction.
   *
   * ⚠️ THE BINDING ON THE FIRST LINE IS LOAD-BEARING — WITHOUT IT THIS LOCKED
   * NOTHING, SILENTLY (MOTIR-3710). Postgres applies the UPDATE policy's `USING`
   * clause to a `SELECT … FOR UPDATE`, because locking a row for update implies
   * update permission — and a row that fails it is FILTERED OUT rather than
   * refused. `organization`'s only UPDATE policy is `organization_mutate_active`
   * (`id = current_setting('app.organization_id', true)`), so from a context that
   * does not bind that GUC — `withWorkspaceContext`, which binds user / workspace
   * / project and nothing else, and which is what every §4 count-cap runs inside —
   * this statement matched ZERO rows, locked nothing, and let every racer through
   * together. Measured before the fix: `{ locked: false, visibleOrgRows: 1 }`. The
   * row was READABLE the whole time (`organization_membership_visible` admits it),
   * which is exactly why the guard read as working.
   *
   * The bind lives HERE rather than at the three call sites because a method whose
   * entire job is "lock THIS org row" cannot do it without the GUC that admits the
   * row, and a lock that silently no-ops is a trap in proportion to how inviting
   * its name is — the same argument `findByIdInTx` above makes (MOTIR-2775). It is
   * ADDITIVE and transaction-local, and it admits exactly the one org row named
   * here and nothing else (`withOrgServiceWriteContext`'s note in
   * `lib/organizations/context.ts` is the reasoning).
   *
   * SECURITY: `id` must be a TRUSTED, server-resolved organization id — every
   * caller resolves it UP from the workspace row, or has already bound the same id
   * itself — never raw request input. Same constraint `bindOrganizationContext`
   * documents.
   */
  async lockByIdForUpdate(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    await bindOrganizationContext(tx, id);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "organization" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows.length > 0;
  },

  /**
   * Read the org's §4 cap context (8.1.11) inside the caller's transaction — the
   * `isMeta` exemption flag + the scaled-tracker subscription, the two signals
   * `pmTierForOrg` resolves the tier from. A missing/hidden org collapses to
   * `{ isMeta: false, scaledTrackerSubscription: null }` (safe-by-default: the
   * bounded `free` tier, caps apply).
   */
  async findCapContextInTx(id: string, tx: Prisma.TransactionClient): Promise<OrgCapContext> {
    const org = await tx.organization.findUnique({
      where: { id },
      select: { isMeta: true, scaledTrackerSubscription: true, aiIncludedSeat: true },
    });
    return toCapContext(org);
  },

  /**
   * The org's own FLEET POOL override (`Organization.fleetPoolCap`, MOTIR-6907),
   * or null when it has none — or when the row is absent or RLS-hidden, which
   * reads as "the environment's number". Must run under the org GUC
   * (`withOrgServiceWriteContext`): the org policies have no system escape.
   */
  async findFleetPoolCapInTx(id: string, tx: Prisma.TransactionClient): Promise<number | null> {
    const org = await tx.organization.findUnique({
      where: { id },
      select: { fleetPoolCap: true },
    });
    return org?.fleetPoolCap ?? null;
  },

  /**
   * The Motir-owned GitHub org the organisation is hosted in (MOTIR-8966), or
   * null when it has none. Read under the org row's lock by the assignment.
   */
  async findHostedGithubOrgInTx(id: string, tx: Prisma.TransactionClient): Promise<string | null> {
    const org = await tx.organization.findUnique({
      where: { id },
      select: { hostedGithubOrg: true },
    });
    return org?.hostedGithubOrg ?? null;
  },

  /** Record the organisation's hosted GitHub org (MOTIR-8966). The caller holds
   *  the row's lock ({@link lockByIdForUpdate}), which also binds the GUC the
   *  UPDATE policy needs. */
  async setHostedGithubOrgInTx(
    id: string,
    githubOrg: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.organization.update({
      where: { id },
      data: { hostedGithubOrg: githubOrg, hostedGithubOrgAssignedAt: at },
    });
  },

  /**
   * How many organisations are hosted in each of `orgLogins`, keyed by the
   * lower-cased login (MOTIR-8966). Case-insensitive, because GitHub logins are.
   * Spans EVERY tenant, so the caller holds a `withSystemContext` transaction
   * (`organization_system_read`): a narrower context would return a smaller,
   * believable number.
   */
  async countByHostedGithubOrgInTx(
    orgLogins: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, number>> {
    const wanted = [...new Set(orgLogins.map((login) => login.trim().toLowerCase()))];
    const counts = new Map<string, number>(wanted.map((login) => [login, 0]));
    if (wanted.length === 0) return counts;
    const rows = await tx.$queryRaw<Array<{ login: string; tenants: bigint }>>`
      SELECT lower("hosted_github_org") AS "login", count(*) AS "tenants"
        FROM "organization"
       WHERE lower("hosted_github_org") = ANY(${wanted})
       GROUP BY lower("hosted_github_org")
    `;
    for (const row of rows) counts.set(row.login, Number(row.tenants));
    return counts;
  },

  /**
   * Read-only (db-singleton) variant of {@link findCapContextInTx} for the §4
   * upload path (8.1.11), which checks the per-file + total-storage caps as a
   * standalone read BEFORE the blob round-trip — no create transaction to thread.
   * Missing/hidden org → the safe default (bounded `free` tier, caps apply).
   */
  async findCapContext(id: string, tx?: Prisma.TransactionClient): Promise<OrgCapContext> {
    const client = tx ?? dbRead;
    const org = await client.organization.findUnique({
      where: { id },
      select: { isMeta: true, scaledTrackerSubscription: true, aiIncludedSeat: true },
    });
    return toCapContext(org);
  },

  /**
   * Set (or clear) the org's scaled-tracker subscription state (8.1.4c). A
   * non-null `state` writes the propagated subscription JSON; `null` clears the
   * column to SQL NULL via `Prisma.DbNull` (the cancel path — non-destructive,
   * `billing-tiering.md` §4). Throws Prisma `P2025` when the org row is absent
   * or RLS-hidden; the service maps that to `OrganizationNotFoundError`. Must
   * run inside a tx whose `app.organization_id` GUC matches `id` (see
   * `withOrgServiceWriteContext`) so the `organization_mutate_active` RLS policy
   * admits the UPDATE under the non-bypass `motir_app` role.
   */
  async updateScaledTrackerState(
    id: string,
    state: ScaledTrackerSubscription | null,
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({
      where: { id },
      data: {
        scaledTrackerSubscription:
          state === null ? Prisma.DbNull : (state as unknown as Prisma.InputJsonValue),
      },
    });
  },

  /**
   * Set the org's `aiIncludedSeat` flag (8.1.24) — true while a PAID Motir AI
   * plan is active (it bundles 1 Motir seat → lifts the §4 caps), false clears
   * it. Same RLS/tx contract as {@link updateScaledTrackerState}; `P2025` when
   * the org is absent/hidden → the service maps it to `OrganizationNotFoundError`.
   */
  async updateAiIncludedSeat(
    id: string,
    included: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({ where: { id }, data: { aiIncludedSeat: included } });
  },

  /**
   * Record or clear the AI-plan lapse (MOTIR-6921). Setting writes only when no
   * lapse is recorded, so a repeated seat-off push keeps the FIRST lapse day and
   * with it every agent's deletion date. Returns the org as it now stands.
   */
  async setAiPlanLapsedAt(
    id: string,
    at: Date | null,
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    if (at !== null) {
      await tx.organization.updateMany({
        where: { id, aiPlanLapsedAt: null },
        data: { aiPlanLapsedAt: at },
      });
      return tx.organization.findUniqueOrThrow({ where: { id } });
    }
    return tx.organization.update({ where: { id }, data: { aiPlanLapsedAt: null } });
  },
};
