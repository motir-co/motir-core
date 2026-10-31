import {
  Prisma,
  type EstimationStatistic,
  type PointScale,
  type PrMergeMode,
  type Project,
  type ProjectAccessMode,
  type ProjectRepoOwnership,
  type WorkflowPolicyMode,
} from '@/generated/prisma/client';
import { db, dbRead } from '@/lib/db';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ProjectSquareRank } from '@/lib/projectSquare/rank';

/**
 * One row of the PROJECT SQUARE directory read (Story 6.13 · Subtask 6.13.2) —
 * the public card-projection columns of a `public` project PLUS its owning
 * organisation (the cross-org context the square shows). Carries ONLY the
 * card-projection fields + the keyset cursor field (`createdAt`); no internal
 * project column (access level, estimation config, workspace id, …) is
 * selected, so the directory read cannot leak one. `id` rides along solely as
 * the keyset tiebreak.
 */
export interface ProjectDirectoryRow {
  id: string;
  identifier: string;
  name: string;
  publicOverviewMd: string | null;
  createdAt: Date;
  org: { name: string; slug: string };
}

/** An opaque keyset cursor position for the directory read (createdAt + id tiebreak). */
export interface ProjectDirectoryCursor {
  createdAt: Date;
  id: string;
}

/**
 * One row of a RANKED project-square page (Story 6.13 · Subtask 6.13.4) — the
 * same card projection as {@link ProjectDirectoryRow} PLUS the row's computed
 * rank sort key, which the service turns into the next page's keyset cursor.
 * Exactly one of `sortScore` (the `trending` / `popular` integer key) and
 * `sortTs` (the `recent` timestamp key) is non-null, per the requested rank.
 */
export interface ProjectDirectoryRankedRow extends ProjectDirectoryRow {
  sortScore: number | null;
  sortTs: Date | null;
}

/**
 * A ranked keyset position the directory read seeks strictly past (Subtask
 * 6.13.4): a numeric `score` for the `trending` / `popular` ranks, or a `ts`
 * timestamp for the `recent` rank — each paired with the last row's `id` (the
 * stable tiebreak that makes every rank a deterministic TOTAL order).
 */
export type ProjectDirectoryRankCursor = { score: number; id: string } | { ts: Date; id: string };

/**
 * Trending-score weights (Subtask 6.13.4): a recent UPVOTE counts more than a
 * recent work-item ACTIVITY event, so demand (someone asked for it) outranks
 * mere churn. The exact weights only shift relative ordering — every rank stays
 * a deterministic total order via the `id` tiebreak regardless — so they are a
 * tunable product knob, not a correctness lever.
 */
const TRENDING_VOTE_WEIGHT = 3;
const TRENDING_ACTIVITY_WEIGHT = 1;

/** Map a ranked raw SQL row's card columns → the shared {@link ProjectDirectoryRow} shape. */
function toRankedCardRow(r: {
  id: string;
  identifier: string;
  name: string;
  publicOverviewMd: string | null;
  createdAt: Date;
  orgName: string;
  orgSlug: string;
}): ProjectDirectoryRow {
  return {
    id: r.id,
    identifier: r.identifier,
    name: r.name,
    publicOverviewMd: r.publicOverviewMd,
    createdAt: r.createdAt,
    org: { name: r.orgName, slug: r.orgSlug },
  };
}

/**
 * Escape the SQL-LIKE metacharacters (`\`, `%`, `_`) in a user-supplied search
 * term so it is matched LITERALLY inside an `ILIKE '%…%'` contains-pattern — a
 * typed `%` or `_` must be a real character, not a wildcard. Backslash is
 * escaped first (so it can't double-escape a following metachar), then `%`/`_`;
 * Postgres' default LIKE escape character is `\`, so no `ESCAPE` clause is
 * needed. The term itself is still bound as a parameter (never concatenated into
 * SQL), so this is about MATCH CORRECTNESS, not injection safety — the parameter
 * binding already guarantees the latter.
 */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Project repository — single Prisma operations on the `project` table.
// Writes require `tx` (compile-time guarantee they run in a transaction);
// pure read paths use the `db` singleton. No business logic, no DTO
// mapping, no transactions here — those belong in projectsService.

/**
 * Every column on `project` that POINTS AT a folder (MOTIR-5821). A folder delete
 * carries each one up to the deleted folder's parent in the same transaction
 * (`carryFolderPointers`), so a pointer never dangles and a raw delete never
 * trips its `NoAction` FK. A new folder pointer joins by DECLARATION here —
 * forgetting it is caught by `tests/integration/folders/plannerBugDestinationCarry.test.ts`,
 * which reads the database's own FK catalog.
 *
 *   · `bugDestinationFolderId`        — where filed product bugs go (MOTIR-4934);
 *     `null` means the project root, chosen.
 *   · `plannerBugDestinationFolderId` — where planner bugs go (MOTIR-5820);
 *     `null` means fall back to the product destination.
 */
export const PROJECT_FOLDER_POINTERS = [
  'bugDestinationFolderId',
  'plannerBugDestinationFolderId',
] as const satisfies readonly (keyof Prisma.ProjectWhereInput)[];

/** The four per-difficulty hosted-agent model override columns (MOTIR-6993). */
export interface ProjectHostedModelOverridesRow {
  hostedModelTrivial: string | null;
  hostedModelLow: string | null;
  hostedModelMedium: string | null;
  hostedModelHigh: string | null;
}

export const projectRepository = {
  /**
   * Every project of an organisation flagged `isMeta` — Motir's own — with its
   * workspace and organisation ids (Story MOTIR-8699 · MOTIR-8714: the projects
   * whose private-repository CI the platform console may move onto the fleet).
   * Cross-tenant by design, so it runs under `withSystemContext`: `project`,
   * `workspace` and `organization` all carry a `system_admin` read arm.
   */
  async listInMetaOrganizations(
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{ id: string; identifier: string; workspaceId: string; organizationId: string }>
  > {
    const rows = await tx.project.findMany({
      where: { workspace: { organization: { isMeta: true } } },
      select: {
        id: true,
        identifier: true,
        workspaceId: true,
        workspace: { select: { organizationId: true } },
      },
      orderBy: { identifier: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      workspaceId: r.workspaceId,
      organizationId: r.workspace.organizationId,
    }));
  },

  /**
   * Read a project by id. Optionally takes `tx` when the caller is already
   * inside a transaction — required when running under the non-bypass
   * motir_app role with the project RLS policy in force, because the
   * policy keys on the per-transaction `app.workspace_id` GUC that
   * withWorkspaceContext binds. Outside withWorkspaceContext the policy
   * sees NULL and hides every row under the non-bypass role.
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Project | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({ where: { id } });
  },

  async findBySlug(workspaceId: string, slug: string): Promise<Project | null> {
    return db.project.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
  },

  /**
   * Read a project by its workspace-unique `identifier` (the `PROD`-style key
   * that prefixes work-item keys). Backs `projectsService.getByKey` — the
   * `?projectKey=` resolution the agent-dispatch endpoints (7.0.4 / 7.0.5)
   * use. Keyed on the `@@unique([workspaceId, identifier])` compound, so the
   * lookup is inherently workspace-scoped: a project living in another
   * workspace is simply not found (the no-existence-leak contract is enforced
   * one layer up, in the service). Optionally takes `tx` so the read sees the
   * project RLS policy's workspace GUC under the non-bypass motir_app role,
   * exactly like `findById`.
   */
  async findByIdentifier(
    workspaceId: string,
    identifier: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Project | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { workspaceId_identifier: { workspaceId, identifier } },
    });
  },

  /**
   * Every project carrying `identifier`, ACROSS workspaces (MOTIR-1799).
   * `identifier` is unique only per workspace, so this can legitimately return
   * more than one row — the caller decides what to do with an ambiguous key.
   *
   * This exists for OPERATOR TOOLING (`scripts/stamp-onboarding-ran.ts`), which
   * is handed a project key with no workspace: it refuses to act on an ambiguous
   * match rather than guessing. It is deliberately NOT reachable from a request
   * path — a user-facing read must stay workspace-scoped via `findByIdentifier`
   * above, or it leaks the existence of other tenants' projects.
   */
  async findAllByIdentifier(identifier: string, tx?: Prisma.TransactionClient): Promise<Project[]> {
    // `tx` lets operator tooling read under `withSystemContext`, which the
    // project policy's system arm admits (MOTIR-8712's sync script).
    const client = tx ?? dbRead;
    return client.project.findMany({ where: { identifier }, orderBy: { createdAt: 'asc' } });
  },

  /**
   * Non-archived projects in a workspace, ordered by createdAt asc so the
   * first-created project lands first in any list surface. Optionally takes
   * `tx` so the read happens inside withWorkspaceContext when the caller
   * needs the project RLS policy to see the workspace GUC (production
   * non-bypass role); outside a tx this falls back to the `db` singleton,
   * which is fine for the BYPASSRLS dev/CI role.
   */
  async findByWorkspace(workspaceId: string, tx?: Prisma.TransactionClient): Promise<Project[]> {
    const client = tx ?? dbRead;
    return client.project.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * EVERY project id in a workspace, ARCHIVED INCLUDED — the unfiltered
   * counterpart of `findByWorkspace` (MOTIR-2166).
   *
   * Its caller is the one workspace delete (`deleteWorkspaceCascade` in
   * `workspacesService`, behind `removeWorkspaceAsOrgAdmin` and
   * `deleteWorkspaceForErasure`), which must enumerate the
   * projects whose derived code graphs need offboarding BEFORE the cascade takes
   * them (`docs/decisions/code-graph-index-fleet.md` §14.3). An archived project's
   * graph still exists, so the archive filter would silently skip it and leave
   * that graph an unreachable orphan — the exact failure the decision is about.
   */
  /** MANY projects by id, in one read — the `Used by N projects` fan-in (Story
   *  MOTIR-4669 · MOTIR-4679). The rows a repository's `project_repository` links
   *  name span the ORGANISATION's workspaces, so this is deliberately NOT
   *  workspace-narrowed: the caller supplies the ids it already resolved and the
   *  RLS context it reads them under. `accessMode` is included because the
   *  answer must then be access-FILTERED per workspace — a count that reveals a
   *  project the viewer may not name is the leak this read exists to avoid. */
  async findManyByIds(ids: readonly string[], tx: Prisma.TransactionClient): Promise<Project[]> {
    if (ids.length === 0) return [];
    return tx.project.findMany({ where: { id: { in: [...ids] } }, orderBy: { name: 'asc' } });
  },

  /**
   * The LIVE members of `ids` — the archive-filtered counterpart of
   * {@link findManyByIds} (MOTIR-5131), standing to it exactly as
   * `findByWorkspace` stands to `findAllIdsByWorkspace`.
   *
   * Its caller is `organizationRepoService.listRepositoryUsage`, which answers
   * `Used by N projects` for the org inventory AND for the DISCONNECT dialog's
   * affected-project list. An archived project is not a user of a repository: it
   * inflates a count a person reads at rest, and it names a dead project in the
   * one disclosure a destructive act rests on.
   *
   * ⚠️ THE PREDICATE IS HERE RATHER THAN ON `findManyByIds` BECAUSE THE OTHER
   * CALLER NEEDS THE ARCHIVED ROWS. `disconnectFromOrganisation` enumerates the
   * same way to clear links and enqueue code-graph offboarding, and an archived
   * project's graph still exists — filtering it there would leave that graph an
   * unreachable orphan, which is the failure `docs/decisions/code-graph-index-fleet.md`
   * §14.3 and MOTIR-2166 are about. So the two callers read DIFFERENT methods,
   * deliberately, and neither should be "simplified" onto the other.
   *
   * Lifecycle only. The ACCESS filter is still the caller's
   * (`projectAccessService.filterBrowsable`, per workspace) — the two narrow for
   * different reasons and neither substitutes for the other. That conflation is
   * what let this survive two prior corrections to the same sentence
   * (MOTIR-4955, MOTIR-4997): the chain had a filter in it, and it was the
   * wrong axis.
   */
  async findManyLiveByIds(
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Project[]> {
    if (ids.length === 0) return [];
    return tx.project.findMany({
      where: { id: { in: [...ids] }, archivedAt: null },
      orderBy: { name: 'asc' },
    });
  },

  /**
   * EVERY project of a workspace — ARCHIVED ones included — as the three columns
   * the entry rule reads (Story MOTIR-6169 · MOTIR-6549). The notification feed
   * filters by entry at READ time, and a notification about an archived
   * project's item must stay visible to someone who could enter that project, so
   * this read does not drop archived rows the way `findByWorkspace` does. Takes
   * `tx`: `project_active_workspace` gates on `app.workspace_id`.
   */
  async findAccessRowsByWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Project, 'id' | 'accessMode'>>> {
    return tx.project.findMany({
      where: { workspaceId },
      select: { id: true, accessMode: true },
    });
  },

  async findAllIdsByWorkspace(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = tx ?? dbRead;
    const rows = await client.project.findMany({
      where: { workspaceId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.id);
  },

  /**
   * The `(workspaceId, id)` pairs among `pairs` that name a project which EXISTS
   * and whose workspace EXISTS — the live set motir-ai's offboarding backstop
   * subtracts from what it has stored (MOTIR-2197).
   *
   * ARCHIVED COUNTS AS LIVE HERE, and the choice is load-bearing rather than
   * incidental: an archive already enqueues its own windowed removal
   * (`docs/decisions/code-graph-index-fleet.md` §14.3), so treating an archived
   * project as absent would let the BACKSTOP delete its graph immediately and
   * silently overrule the 30-day grace period the user was promised. The archive
   * path owns that timing; this read must not second-guess it.
   *
   * The `workspaceId` in the WHERE is not redundant with the project id: it makes
   * the answer wrong-scoped rather than merely wrong if a caller pairs a real
   * project with someone else's workspace, and the join to `workspace` is what
   * covers the cascade case (the project row goes with its workspace, but a
   * caller can still ask about a pair whose workspace alone is gone).
   */
  async findLivePairs(
    pairs: { workspaceId: string; projectId: string }[],
    tx?: Prisma.TransactionClient,
  ): Promise<{ workspaceId: string; projectId: string }[]> {
    if (pairs.length === 0) return [];
    const client = tx ?? dbRead;
    const rows = await client.project.findMany({
      where: {
        OR: pairs.map((pair) => ({ id: pair.projectId, workspaceId: pair.workspaceId })),
        // The project row cascades with its workspace, so a surviving row implies
        // a surviving workspace — asserted rather than assumed, because this read
        // is what stands between a reconciler and a live tenant's data.
        workspace: { is: {} },
      },
      select: { id: true, workspaceId: true },
    });
    return rows.map((row) => ({ workspaceId: row.workspaceId, projectId: row.id }));
  },

  async create(
    data: { workspaceId: string; name: string; slug: string; identifier: string },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.create({ data });
  },

  /**
   * How many projects a workspace holds, ARCHIVED ONES INCLUDED — the erasure
   * impact preview's "the work inside them" number (MOTIR-3699), read per
   * sole-membership workspace.
   *
   * ⚠️ ARCHIVED ROWS COUNT, deliberately. Every other project read in this file
   * filters `archivedAt: null`, because a board or a picker is asking what the
   * reader can WORK on. This one is asking what deletion REACHES, and deleting
   * the workspace takes the archived projects with it — a ledger that omitted
   * them would understate the loss on the one screen where understating it
   * matters.
   *
   * `tx` REQUIRED: `project_active_workspace` gates on `app.workspace_id`, so an
   * unbound count answers zero for every workspace and raises nothing.
   */
  async countByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.project.count({ where: { workspaceId } });
  },

  /**
   * Count projects across an organization (§4.2 cap, 8.1.11) — every project in
   * every workspace of the org, joined `project → workspace`. Takes `tx` so the
   * count + the guarded create run in one transaction, serialized by the org row
   * lock (`organizationRepository.lockByIdForUpdate`). Raw SQL because the count
   * crosses the workspace join at the org boundary (the ungameable org-wide count
   * §4 mandates), not the active-workspace scope a Prisma `count` sees.
   */
  async countByOrganization(organizationId: string, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM "project" p
      JOIN "workspace" w ON w."id" = p."workspaceId"
      WHERE w."organizationId" = ${organizationId}
    `;
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Resolve a PUBLIC project by its `identifier` (the `PROD`-style key) WITHOUT
   * a workspace scope — the lookup behind the anonymous public view
   * (`/p/[identifier]`, Story 6.12 · Subtask 6.12.4). The public surface knows
   * only the key, not the workspace, so this is one of the few deliberately
   * cross-workspace reads; it is constrained to `accessMode = 'public'` and
   * non-archived rows so it can never resolve a private/internal project (the
   * no-existence-leak posture is preserved — a non-public key resolves to null,
   * and the projectAccessService gate re-confirms `public` regardless).
   * `identifier` is unique per workspace; if two workspaces ever both made a
   * project with the same key public, this returns the most recently updated
   * (deterministic) — an acceptable edge for the showcase tenant, and a true
   * collision is resolved by the gate + the key-uniqueness the product enforces
   * per workspace. Read-only → `db` singleton.
   */
  async findPublicByIdentifier(identifier: string): Promise<Project | null> {
    return db.project.findFirst({
      where: { identifier, accessMode: 'public', archivedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * Every PUBLIC (accessMode = 'public'), non-archived project across ALL
   * workspaces (Story 6.12 · Subtask 6.12.4). This is the ONE project read that
   * is deliberately NOT workspace-scoped: a public project is crawlable
   * cross-org, so every one is listed regardless of tenant. Read-only path →
   * `db` singleton. Ordered by `updatedAt` desc so the freshest lead.
   *
   * ⚠️ It was named for `app/sitemap.ts`, which no longer exists. MOTIR-3951
   * moved the crawlable pages to `motir.co` and MOTIR-4583 deleted the route
   * outright (an empty `<urlset>` is schema-invalid — see
   * `lib/robotsPolicy.ts`). The read is still LIVE:
   * `publicFollowDigestService` is its consumer, through
   * `publicProjectsService.listPublicForSitemap`. The name is kept because
   * `tests/rls/singleton-read-guard.test.ts` pins its verdict by it.
   */
  /**
   * Every PUBLIC, non-archived project in ONE workspace — what a workspace
   * subdomain's root lists (MOTIR-4217; the ADR §3 rule that
   * `<workspace>.<base>/` lists that workspace's public projects).
   *
   * Anonymous: the `db` singleton with no workspace bound, admitted by
   * `project_public_read`. A workspace whose projects are all private answers
   * with an EMPTY list rather than an error — which is the honest answer and is
   * also what keeps the host resolution from leaking whether the workspace
   * exists.
   */
  /**
   * The workspace's display NAME, for a subdomain root that lists its projects.
   * Anonymous — admitted by `workspace_public_project_read`, which requires the
   * workspace to hold at least one public project, so a workspace with none
   * answers `null` and the host 404s.
   */
  async findWorkspaceNameForPublic(workspaceId: string): Promise<string | null> {
    const row = await db.workspace.findFirst({
      where: { id: workspaceId },
      select: { name: true },
    });
    return row?.name ?? null;
  },

  async listPublic(): Promise<Array<Pick<Project, 'identifier' | 'updatedAt'>>> {
    return db.project.findMany({
      where: { accessMode: 'public', archivedAt: null },
      select: { identifier: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * One PAGE of the same set {@link listPublic} returns — the crawl enumeration
   * (MOTIR-4111), keyset-paginated on `id`.
   *
   * ⚠️ ORDERED BY `id`, NOT BY `updatedAt`, AND THAT IS THE WHOLE DESIGN. The
   * consumer is a sitemap generator walking every page in sequence over a set
   * that mutates while it walks. `updatedAt DESC` reshuffles under that walk: any
   * project edited between page 1 and page 2 moves to the head, pushing a row the
   * crawler has already passed onto a page it has not reached — so a project can
   * be enumerated twice, or skipped entirely, and nothing reports it. `id` is a
   * cuid: unique, immutable, and a deterministic TOTAL order, so a row's position
   * in the walk cannot move. `updatedAt` is still RETURNED — it is the
   * `<lastmod>` the sitemap writes — it just does not order the walk.
   *
   * Read-only cross-org path → the `db` singleton with the in-SQL
   * `access_mode = 'public'` filter, the same RLS-secondary posture the other
   * anonymous public reads use (finding #26).
   */
  async listPublicIndexPage(options: {
    take: number;
    cursor?: string | undefined;
  }): Promise<Array<Pick<Project, 'id' | 'identifier' | 'updatedAt' | 'workspaceId'>>> {
    const { take, cursor } = options;
    return db.project.findMany({
      where: { accessMode: 'public', archivedAt: null },
      // `workspaceId` rides along for MOTIR-4217's per-row canonical HOST: a
      // subdomain belongs to the workspace, so the host cannot be derived from
      // the project alone.
      select: { id: true, identifier: true, updatedAt: true, workspaceId: true },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * A RANKED page of the PROJECT SQUARE (Story 6.13 · Subtask 6.13.4) — the same
   * cross-org `public`, non-archived projects {@link listPublicDirectory}
   * returns, but ordered by one of the three demand ranks instead of creation
   * order, and keyset-paginated over THAT rank's sort key (finding #57 — a
   * system-level list is never load-all). Each rank is a DETERMINISTIC TOTAL
   * order — the rank key with a stable `id DESC` tiebreak — so the keyset cursor
   * skips/duplicates no row across pages even on tied keys:
   *
   *   • `popular`  — LIFETIME total upvotes across the project's public requests
   *     (the "most-starred" axis; 6.12.6 shipped no viewer count, so upvotes are
   *     the real lifetime signal — the documented `ProjectSquareStatsDto` gap).
   *   • `trending` — RECENT demand inside `cutoff..now`: windowed upvotes
   *     (weighted {@link TRENDING_VOTE_WEIGHT}) + windowed work-item activity
   *     (weighted {@link TRENDING_ACTIVITY_WEIGHT}), so a freshly-surging project
   *     outranks a higher-lifetime-but-stale one. `cutoff` is a bound JS Date the
   *     SERVICE computes (`now - windowMs`) — NEVER SQL `NOW()` (a timestamp /
   *     timestamptz session-TZ skew, flaky in CI; the `aggregateCreatedByBucket`
   *     rule). REQUIRED for this rank.
   *   • `recent`   — newly-made-public: `COALESCE(madePublicAt, createdAt)` DESC,
   *     so a project sorts by when it became public, falling back to its creation
   *     moment when it predates the `made_public_at` column (every row therefore
   *     has a non-null key — no NULL-ordering ambiguity).
   *
   * The score subqueries are CORRELATED per project — computed at read time over
   * the live 6.12.6 vote/activity rows, NOT a denormalized rank column this story
   * must keep fresh. If this proves too costly at scale, the durable shape is a
   * bounded MATERIALIZED read (still deterministic + cursored), not a
   * load-all-then-sort-in-memory shortcut. Scalar subqueries (not joins) keep the
   * per-project aggregates from fanning out the row set. Read-only cross-org path
   * → `db` singleton + the in-SQL `access_mode = 'public'` filter (the
   * RLS-secondary posture the other anonymous public reads use; finding #26).
   */
  async listPublicDirectoryRanked(options: {
    rank: ProjectSquareRank;
    take: number;
    cursor?: ProjectDirectoryRankCursor;
    /** Required for `trending` — the recency-window cutoff (a bound JS Date). */
    cutoff?: Date;
    /**
     * The 6.13.3 SEARCH narrowing — a name/description contains-match. Compiled
     * to a parameterized `ILIKE '%term%'` over `name` + `public_overview_md`
     * (the trgm GIN index serves it); the caller has already trimmed it, so a
     * present value is non-empty. Absent → no search predicate.
     */
    search?: string;
    /**
     * The 6.13.3 CATEGORY/TAG narrowing — a curated tag slug (the caller has
     * already validated it against the vocabulary). Compiled to an EXISTS over
     * `project_tag_assignment` joined to `project_tag` by slug. Absent → no tag
     * predicate.
     */
    categorySlug?: string;
  }): Promise<ProjectDirectoryRankedRow[]> {
    const { rank, take, cursor, cutoff, search, categorySlug } = options;

    // The shared card projection + the cross-org join + the single public filter
    // (the `access_mode = 'public'` predicate lives HERE so no non-public project
    // leaks through any rank). `public_overview_md` is `@map`-ed; the rest of the
    // project/org columns are camelCase, so they are quoted as-is.
    const cardCols = Prisma.sql`
      p."id" AS "id",
      p."identifier" AS "identifier",
      p."name" AS "name",
      p."public_overview_md" AS "publicOverviewMd",
      p."createdAt" AS "createdAt",
      o."name" AS "orgName",
      o."slug" AS "orgSlug"`;
    // The 6.13.3 NARROWING predicates, ANDed into the single public-filter WHERE
    // so they bind at the base scan (every rank's CTE reads through `fromPublic`,
    // so the narrowing composes with all three ranks AND the keyset cursor for
    // free). Both are PARAMETERIZED — no user string is concatenated into SQL
    // (the 6.1.1 injection-safety posture):
    //   • search → a case-insensitive contains-match over the project `name` +
    //     the public `public_overview_md` overview. LIKE metacharacters in the
    //     user input are escaped (`escapeLikePattern`) so a typed `%`/`_` matches
    //     literally, not as a wildcard; Postgres' default `\` LIKE escape then
    //     applies. The trgm GIN index (this subtask's migration) serves it.
    //   • category → an EXISTS over the project↔tag join resolved by slug. Only
    //     the `public` projects already in `fromPublic` are considered, so the
    //     tag filter can never surface a non-public project.
    const searchPredicate =
      search !== undefined
        ? Prisma.sql` AND (p."name" ILIKE ${'%' + escapeLikePattern(search) + '%'} OR p."public_overview_md" ILIKE ${'%' + escapeLikePattern(search) + '%'})`
        : Prisma.empty;
    const categoryPredicate =
      categorySlug !== undefined
        ? Prisma.sql` AND EXISTS (
            SELECT 1 FROM "project_tag_assignment" pta
              JOIN "project_tag" pt ON pt."id" = pta."tag_id"
             WHERE pta."project_id" = p."id" AND pt."slug" = ${categorySlug})`
        : Prisma.empty;
    const fromPublic = Prisma.sql`
      FROM "project" p
      JOIN "workspace" w ON w."id" = p."workspaceId"
      JOIN "organization" o ON o."id" = w."organizationId"
      WHERE p."access_mode" = 'public'::"project_access_mode" AND p."archivedAt" IS NULL${searchPredicate}${categoryPredicate}`;

    if (rank === 'recent') {
      // Timestamp rank: COALESCE(madePublicAt, createdAt) DESC, id DESC.
      const tsCursor = cursor && 'ts' in cursor ? cursor : undefined;
      const keyset = tsCursor
        ? Prisma.sql`WHERE ("sortTs" < ${tsCursor.ts} OR ("sortTs" = ${tsCursor.ts} AND "id" < ${tsCursor.id}))`
        : Prisma.empty;
      const rows = await db.$queryRaw<
        Array<{
          id: string;
          identifier: string;
          name: string;
          publicOverviewMd: string | null;
          createdAt: Date;
          orgName: string;
          orgSlug: string;
          sortTs: Date;
        }>
      >(Prisma.sql`
        WITH ranked AS (
          SELECT ${cardCols}, COALESCE(p."made_public_at", p."createdAt") AS "sortTs"
          ${fromPublic}
        )
        SELECT * FROM ranked
        ${keyset}
        ORDER BY "sortTs" DESC, "id" DESC
        LIMIT ${take}`);
      return rows.map((r) => ({ ...toRankedCardRow(r), sortScore: null, sortTs: r.sortTs }));
    }

    // Numeric ranks (`popular` / `trending`): score DESC, id DESC.
    const scoreExpr =
      rank === 'popular'
        ? Prisma.sql`(
            SELECT COUNT(*) FROM "public_request_vote" v
              JOIN "work_item" wi ON wi."id" = v."work_item_id"
             WHERE wi."projectId" = p."id"
          )::int`
        : // `trending` — windowed upvotes + windowed activity, weighted. The
          // `cutoff` Date is bound, never SQL NOW() (the timestamp-TZ-skew rule).
          Prisma.sql`(
              (SELECT COUNT(*) FROM "public_request_vote" v
                 JOIN "work_item" wi ON wi."id" = v."work_item_id"
                WHERE wi."projectId" = p."id" AND v."created_at" >= ${cutoff})::int * ${TRENDING_VOTE_WEIGHT}
            + (SELECT COUNT(*) FROM "work_item" wa
                WHERE wa."projectId" = p."id" AND wa."archivedAt" IS NULL
                  AND wa."triagedAt" IS NULL AND wa."updatedAt" >= ${cutoff})::int * ${TRENDING_ACTIVITY_WEIGHT}
          )::int`;
    const scoreCursor = cursor && 'score' in cursor ? cursor : undefined;
    const keyset = scoreCursor
      ? Prisma.sql`WHERE ("sortScore" < ${scoreCursor.score} OR ("sortScore" = ${scoreCursor.score} AND "id" < ${scoreCursor.id}))`
      : Prisma.empty;
    const rows = await db.$queryRaw<
      Array<{
        id: string;
        identifier: string;
        name: string;
        publicOverviewMd: string | null;
        createdAt: Date;
        orgName: string;
        orgSlug: string;
        sortScore: number;
      }>
    >(Prisma.sql`
      WITH ranked AS (
        SELECT ${cardCols}, ${scoreExpr} AS "sortScore"
        ${fromPublic}
      )
      SELECT * FROM ranked
      ${keyset}
      ORDER BY "sortScore" DESC, "id" DESC
      LIMIT ${take}`);
    return rows.map((r) => ({
      ...toRankedCardRow(r),
      sortScore: Number(r.sortScore),
      sortTs: null,
    }));
  },

  /**
   * Acquire a row-level lock on the project inside the caller's transaction —
   * the guarding read for the key-change flow (Story 6.8 · projectsService
   * `changeKey`): lock the row, then run the collision guards + the bulk
   * identifier rewrite + the alias insert, all serialized against a concurrent
   * rename OR a concurrent `allocateWorkItemNumber`-backed issue creation on the
   * same project (the lock-before-read-derived-update rule). Without it two
   * renames could each read the pre-change identifier and clobber each other,
   * or an issue could be minted with the stale prefix mid-rewrite. Returns null
   * when the id doesn't exist. Mirrors workItemRepository.lockById /
   * userRepository.lockById.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "project" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async update(
    id: string,
    data: { name?: string; image?: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Stamp the immutable onboarding-ran marker (Subtask 7.4 / MOTIR-1264) the
   * FIRST time a project's plan is approved + materialized. A NULL-guarded
   * `updateMany` makes this SET-ONCE at the DB level: only the row whose
   * `onboardingRanAt` is still NULL is written, so a re-approve OR two concurrent
   * approves leave the original stamp untouched (the WHERE-on-NULL is the
   * immutability guard — no `FOR UPDATE` needed, the conditional update is itself
   * atomic). Returns the number of rows stamped: 1 on the first approve, 0 after.
   */
  async markOnboardingRan(id: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.project.updateMany({
      where: { id, onboardingRanAt: null },
      data: { onboardingRanAt: at },
    });
    return r.count;
  },

  /**
   * Set the project's `identifier` (the "key") — the project-row half of the
   * key-change transaction (Story 6.8). The work-item identifier rewrite is the
   * separate bulk op `workItemRepository.rewriteIdentifiersForProject`, and the
   * old key is recorded by `projectKeyAliasRepository.create`; the service
   * orchestrates all three plus the FOR-UPDATE lock in one transaction.
   */
  async updateIdentifier(
    id: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { identifier } });
  },

  /**
   * Soft-delete: stamp archivedAt = now(). Projects are NEVER hard-deleted
   * — work-item history (Story 1.4) must survive an archive.
   */
  async archive(id: string, tx: Prisma.TransactionClient): Promise<Project> {
    return tx.project.update({ where: { id }, data: { archivedAt: new Date() } });
  },

  /** Flip the project's workflow policy mode (Subtask 2.2.5). */
  async updateWorkflowPolicyMode(
    id: string,
    mode: WorkflowPolicyMode,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { workflowPolicyMode: mode } });
  },

  /**
   * Set the project's ACCESS MODE (Story MOTIR-6169 · MOTIR-6541) — `access_mode`
   * and nothing else of the access model. THE ONLY WRITER of `access_mode`. The
   * retired `accessLevel` is no longer written (MOTIR-6692): nothing has read it
   * since MOTIR-6687, and its field is `@ignore`d pending the phase-3 drop.
   * `stampMadePublicAt` stamps `madePublicAt` (the project square's
   * "newest" axis, Subtask 6.13.4); the service passes it only on the
   * not-public → public edge, so a re-save keeps the original go-public moment.
   */
  async setAccessMode(
    id: string,
    accessMode: ProjectAccessMode,
    tx: Prisma.TransactionClient,
    options: { stampMadePublicAt?: boolean } = {},
  ): Promise<Project> {
    return tx.project.update({
      where: { id },
      data: {
        accessMode,
        ...(options.stampMadePublicAt ? { madePublicAt: new Date() } : {}),
      },
    });
  },

  /**
   * Set the project's public hero fields — the Overview/README body (Story 6.12
   * · Subtask 6.12.8) plus the tagline + tags (Story 6.16 · Subtask 6.16.3). A
   * PARTIAL update: only the keys present in `data` are written, so a caller can
   * author one field without touching the others. `publicOverviewMd` /
   * `publicTagline` set to `null` clears that field (the public surface then
   * falls back to its default); `publicTags` is replaced wholesale with the
   * given array. Public-safe fields that ride the public projection only when
   * the project is `public`. The service owns validation; this is the single
   * Prisma op.
   */
  async setPublicOverview(
    id: string,
    data: {
      publicOverviewMd?: string | null;
      publicTagline?: string | null;
      publicTags?: string[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  // --- Estimation config (Story 4.3 · Subtask 4.3.3) ------------------------
  // The project-scoped estimation settings (`estimationStatistic` / `pointScale`
  // / `customScaleValues`; see the story-4.3 module header for the
  // project-scoped justified deviation). Single Prisma ops; the read is a
  // projection (the roll-up only needs the statistic) used by the read-only
  // roll-up paths, so it takes no `tx`; the update REQUIRES `tx`.

  /**
   * Read just a project's estimation config columns (the projection the roll-up
   * statistic resolution + the settings read need). Returns null when the
   * project doesn't exist — the caller (estimationService) owns the tenant gate
   * + the not-found error. Read-only path → `db` singleton.
   */
  async findEstimationConfig(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    estimationStatistic: EstimationStatistic;
    pointScale: PointScale;
    customScaleValues: number[];
  } | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { id },
      select: { estimationStatistic: true, pointScale: true, customScaleValues: true },
    });
  },

  /**
   * Update a project's estimation config (any subset of the three fields). `tx`
   * REQUIRED; the caller (estimationService) has already tenant-gated +
   * admin-gated the project, so this is a plain id-keyed update.
   */
  async updateEstimationConfig(
    id: string,
    data: {
      estimationStatistic?: EstimationStatistic;
      pointScale?: PointScale;
      customScaleValues?: number[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  // --- AI-planning settings (Story 7.13 · Subtask MOTIR-915) ---------------
  // The project-scoped AI configuration (`aiAutoPlanEnabled` /
  // `aiAutoPlanThreshold` / `aiSprintPlanningEnabled` / `aiSprintLengthDays`,
  // plus the Story-7.4 `aiGenerateExplanations` the same panel surfaces).
  // The retired planner-model column is `@ignore`d (MOTIR-7228): nothing selects it. Open-core `project` COLUMNS, not an AI-only table — so the read is
  // an ordinary project projection. Single Prisma ops; the read takes an optional
  // `tx` (the cadence engine reads it outside a transaction, the settings service
  // inside one), the update REQUIRES `tx`.

  /**
   * Read just a project's AI-settings columns — the projection the AI-settings
   * surface (MOTIR-919) and the cadence engine (MOTIR-916) need, without pulling
   * the whole project row. Returns null when the project doesn't exist; the
   * caller (`projectAiSettingsService`) owns the tenant gate + the not-found
   * error. Read-only path → `db` singleton unless a `tx` is supplied (needed
   * under the non-bypass `motir_app` role, where the project RLS policy keys on
   * the per-transaction workspace GUC — same contract as `findById`).
   */
  async findAiSettings(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    aiAutoPlanEnabled: boolean;
    aiAutoPlanThreshold: number;
    aiSprintPlanningEnabled: boolean;
    aiSprintLengthDays: number;
    aiGenerateExplanations: boolean;
    aiRecordPlanningMistakes: boolean | null;
  } | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { id },
      select: {
        aiAutoPlanEnabled: true,
        aiAutoPlanThreshold: true,
        aiSprintPlanningEnabled: true,
        aiSprintLengthDays: true,
        aiGenerateExplanations: true,
        aiRecordPlanningMistakes: true,
      },
    });
  },

  // The project-scoped STATUS-AUTOMATION configuration (Story MOTIR-1615 ·
  // MOTIR-1618) — `autoRollupParentStatus` / `autoCompleteChildrenOnParentDone`,
  // the two on/off switches for bidirectional parent↔child status derivation
  // (`docs/decisions/status-derivation.md`). Same shape as the AI-settings pair
  // above: ordinary project columns, a narrow read projection with an optional
  // `tx`, and a required-`tx` update.

  /**
   * Read just a project's status-automation columns. Two consumers, which is why
   * this is a projection rather than a whole-row read: the settings surface
   * (MOTIR-1622) and — on EVERY status transition — the derivation job
   * (MOTIR-1621), whose two services each check their own switch before doing any
   * work. Returns null when the project doesn't exist; the caller owns the tenant
   * gate + the not-found error. Read-only path → `db` singleton unless a `tx` is
   * supplied (needed under the non-bypass `motir_app` role, where the project
   * RLS policy keys on the per-transaction workspace GUC — same contract as
   * `findById`).
   */
  async findStatusAutomation(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    autoRollupParentStatus: boolean;
    autoCompleteChildrenOnParentDone: boolean;
  } | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { id },
      select: { autoRollupParentStatus: true, autoCompleteChildrenOnParentDone: true },
    });
  },

  /**
   * Patch a project's status-automation columns. Partial by contract — only the
   * supplied switches are written, so saving one toggle never clobbers the other.
   * Write → `tx` REQUIRED.
   */
  async updateStatusAutomation(
    id: string,
    data: {
      autoRollupParentStatus?: boolean;
      autoCompleteChildrenOnParentDone?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Update a project's APPROVAL-GATE switches (Story MOTIR-4925 · Subtask
   * MOTIR-5170) — which gates this project raises. `tx` REQUIRED; the caller
   * (`approvalGateSettingsService`) has already resolved the project and asserted
   * `workflow:manage`, so this is a plain id-keyed update.
   *
   * Written as a SUBSET object rather than a single boolean because a second
   * project-tier gate switch is already decided (`approval-gates.md` §7's merge
   * mode), and the mirror of `updateStatusAutomation` above is the shape this
   * repository already uses for a pair of related project booleans.
   */
  async updateApprovalGateSettings(
    id: string,
    data: {
      acceptanceVideoEnabled?: boolean;
      reviewAgentEnabled?: boolean;
      designApprovalGate?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Read just a project's auto-translate switch (Story MOTIR-7738 · MOTIR-8826) —
   * the stored value, never a computed default. Null when the id doesn't exist.
   * Optional `tx` — same contract as `findStatusAutomation`.
   */
  async findAutoTranslateWorkContent(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ autoTranslateWorkContent: boolean } | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { id },
      select: { autoTranslateWorkContent: true },
    });
  },

  /**
   * Write a project's auto-translate switch. `tx` REQUIRED; the caller
   * (`projectAutoTranslateSettingsService`) has asserted `project:administer`,
   * holds the row lock and appends the trail row in the same transaction.
   */
  async updateAutoTranslateWorkContent(
    id: string,
    autoTranslateWorkContent: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<{ autoTranslateWorkContent: boolean }> {
    return tx.project.update({
      where: { id },
      data: { autoTranslateWorkContent },
      select: { autoTranslateWorkContent: true },
    });
  },

  /**
   * Read just a project's agent auto-fix switch (Story MOTIR-8981 · MOTIR-9060) —
   * the stored value, never a computed default. Null when the id doesn't exist.
   * Optional `tx` — same contract as `findAutoTranslateWorkContent`.
   */
  async findAgentAutoFixEnabled(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ agentAutoFixEnabled: boolean } | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { id },
      select: { agentAutoFixEnabled: true },
    });
  },

  /**
   * Write a project's agent auto-fix switch. `tx` REQUIRED; the caller
   * (`projectAgentAutoFixSettingsService`) has asserted `ai:configure` and holds
   * the row lock.
   */
  async updateAgentAutoFixEnabled(
    id: string,
    agentAutoFixEnabled: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<{ agentAutoFixEnabled: boolean }> {
    return tx.project.update({
      where: { id },
      data: { agentAutoFixEnabled },
      select: { agentAutoFixEnabled: true },
    });
  },

  // --- Merge mode (Story MOTIR-4880 · Subtask MOTIR-5177) -------------------
  // `prMergeMode` + its `prMergeModeDecidedAt` stamp (`approval-gates.md` §7 and
  // its 2026-09-13 amendment). The stamp is what separates the column's FLOOR
  // from a decided value, so both are read and written together.

  /**
   * Read just a project's merge mode and whether it has been decided. Returns
   * null when the project doesn't exist; the caller owns the tenant gate + the
   * not-found error. Optional `tx` — same contract as `findStatusAutomation`.
   */
  async findPrMergeMode(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ prMergeMode: PrMergeMode; prMergeModeDecidedAt: Date | null } | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { id },
      select: { prMergeMode: true, prMergeModeDecidedAt: true },
    });
  },

  /**
   * The project's two MERGE-ASKING settings together — `prMergeMode` and the review
   * agent's switch (Story MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.2/§12.2a). Read
   * by the gate-set loader, which needs both to answer which question a green set asks.
   */
  async findMergeSettings(
    id: string,

    tx: Prisma.TransactionClient,
  ): Promise<{ prMergeMode: PrMergeMode; reviewAgentEnabled: boolean } | null> {
    return tx.project.findUnique({
      where: { id },
      select: { prMergeMode: true, reviewAgentEnabled: true },
    });
  },

  /**
   * Write a DECIDED merge mode — a person's choice — and stamp it. Unconditional:
   * a person may change their own decision as often as they like. `tx` REQUIRED;
   * the caller has already resolved the project and asserted the permission.
   */
  async setPrMergeMode(
    id: string,
    mode: PrMergeMode,
    decidedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({
      where: { id },
      data: { prMergeMode: mode, prMergeModeDecidedAt: decidedAt },
    });
  },

  /**
   * Point the project's BUG DESTINATION at a folder, or at `null` — the project
   * ROOT, chosen (Story MOTIR-4927 · MOTIR-4934). Unconditional; `tx` REQUIRED.
   * The same-project rule is the database's
   * (`trg_project_bug_destination_folder_tenancy`), so a folder of another
   * project surfaces as a refused write, never as a stored pointer.
   */
  async setBugDestinationFolder(
    id: string,
    folderId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({
      where: { id },
      data: { bugDestinationFolderId: folderId },
    });
  },

  /**
   * CARRY every project FOLDER POINTER off a folder that is about to be deleted
   * (MOTIR-5537, widened to the set by MOTIR-5821): for each pointer in
   * `PROJECT_FOLDER_POINTERS` that names `fromFolderId` on `projectId`, point it
   * at `toFolderId` — the deleted folder's parent, or `null` when the folder was
   * a root. Each write is conditional in its WHERE, so a pointer naming
   * elsewhere is not written. Returns the rows written, summed across pointers.
   * `tx` REQUIRED — it runs inside the delete's own transaction, under its
   * structure lock, and before the delete: every pointer is a `NoAction` FK.
   */
  async carryFolderPointers(
    projectId: string,
    fromFolderId: string,
    toFolderId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    let written = 0;
    for (const pointer of PROJECT_FOLDER_POINTERS) {
      const result = await tx.project.updateMany({
        where: { id: projectId, [pointer]: fromFolderId },
        data: { [pointer]: toFolderId },
      });
      written += result.count;
    }
    return written;
  },

  /**
   * Write the ESTABLISHMENT default and stamp it — SET-ONCE at the database level
   * (MOTIR-5178). The NULL-guarded `updateMany` writes only a row whose
   * `prMergeModeDecidedAt` is still null, so a value a person already decided is
   * never overwritten, whatever the caller read. Returns the rows written: 1 when
   * the default landed, 0 when something had already decided the value. Same
   * shape as `markOnboardingRan`.
   */
  async seedPrMergeModeIfUndecided(
    id: string,
    mode: PrMergeMode,
    decidedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.project.updateMany({
      where: { id, prMergeModeDecidedAt: null },
      data: { prMergeMode: mode, prMergeModeDecidedAt: decidedAt },
    });
    return r.count;
  },

  /**
   * The CROSS-WORKSPACE scan behind the auto-plan cadence tick (MOTIR-916):
   * every non-archived project that opted into auto-planning, keyset-paginated
   * by id so the sweep is bounded per page (the `listDueByHour` precedent —
   * finding #57). Returns only what the sweep needs to decide and act: the id,
   * the workspace (which owner to act as), and the threshold to compare the
   * ready count against.
   *
   * `tx` REQUIRED and expected to be a `withSystemContext` transaction: this is
   * the one project read with NO workspace to bind, so it rides the
   * `app.system_admin` READ branch the cadence migration added to the project
   * policy. Everything the sweep does afterwards runs per project inside that
   * project's own workspace context.
   */
  async listAutoPlanEnabled(
    opts: { take: number; cursor?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string; aiAutoPlanThreshold: number }>> {
    return tx.project.findMany({
      where: { aiAutoPlanEnabled: true, archivedAt: null },
      select: { id: true, workspaceId: true, aiAutoPlanThreshold: true },
      orderBy: { id: 'asc' },
      take: opts.take,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Every live (non-archived) project across ALL workspaces, keyset-paged by id —
   * the discovery read of the work-item embedding sweep (Story MOTIR-8226 ·
   * MOTIR-8227). Same cross-tenant shape as {@link listAutoPlanEnabled}: the caller
   * runs it under `withSystemContext`, whose system_admin read branch on the
   * project policy is what lets it see every tenant's rows, and everything the
   * sweep does afterwards runs per project inside that project's own workspace.
   */
  async listLiveAcrossWorkspaces(
    opts: { take: number; cursor?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    return tx.project.findMany({
      where: { archivedAt: null },
      select: { id: true, workspaceId: true },
      orderBy: { id: 'asc' },
      take: opts.take,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Update a project's AI-settings columns (any subset). `tx` REQUIRED; the
   * caller (`projectAiSettingsService`) has already resolved + admin-gated the
   * project and validated every value, so this is a plain id-keyed update.
   */
  /**
   * A project's four hosted-agent model overrides, one per leaf difficulty
   * (Story MOTIR-6989 · MOTIR-6993). NULL = use the platform default for that
   * level. Read by `projectHostedAgentSettingsService`, inside its transaction
   * or standalone.
   */
  async findHostedModelOverrides(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectHostedModelOverridesRow | null> {
    const client = tx ?? dbRead;
    return client.project.findUnique({
      where: { id },
      select: {
        hostedModelTrivial: true,
        hostedModelLow: true,
        hostedModelMedium: true,
        hostedModelHigh: true,
      },
    });
  },

  /**
   * Every LIVE (unarchived) project that overrides its hosted model at ANY
   * level, across the estate (Story MOTIR-7521 · MOTIR-7525) — what the
   * run-model list says each model is used by, and what a remove is refused
   * for. A cross-tenant read: `tx` REQUIRED, and it is a `withPlatformRead`
   * transaction, whose `app.platform_staff` arm on `project` admits every row.
   */
  async findLiveWithHostedModelOverrides(
    tx: Prisma.TransactionClient,
  ): Promise<({ identifier: string; name: string } & ProjectHostedModelOverridesRow)[]> {
    return tx.project.findMany({
      where: {
        archivedAt: null,
        OR: [
          { hostedModelTrivial: { not: null } },
          { hostedModelLow: { not: null } },
          { hostedModelMedium: { not: null } },
          { hostedModelHigh: { not: null } },
        ],
      },
      select: {
        identifier: true,
        name: true,
        hostedModelTrivial: true,
        hostedModelLow: true,
        hostedModelMedium: true,
        hostedModelHigh: true,
      },
      orderBy: { identifier: 'asc' },
    });
  },

  /**
   * Write any subset of the four hosted-agent model overrides (MOTIR-6993); an
   * absent field is untouched and `null` resets that level to the platform
   * default. `tx` REQUIRED — the service validates against motir-ai's offered
   * list and gates on `ai:configure` in the same transaction.
   */
  async updateHostedModelOverrides(
    id: string,
    data: Partial<ProjectHostedModelOverridesRow>,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectHostedModelOverridesRow> {
    return tx.project.update({
      where: { id },
      data,
      select: {
        hostedModelTrivial: true,
        hostedModelLow: true,
        hostedModelMedium: true,
        hostedModelHigh: true,
      },
    });
  },

  async updateAiSettings(
    id: string,
    data: {
      aiAutoPlanEnabled?: boolean;
      aiAutoPlanThreshold?: number;
      aiSprintPlanningEnabled?: boolean;
      aiSprintLengthDays?: number;
      aiGenerateExplanations?: boolean;
      aiRecordPlanningMistakes?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Record WHO owns the project's repository SET and WHICH account it lands in
   * (Story MOTIR-1775 · MOTIR-1780; `docs/decisions/project-repository-set.md`
   * §3.2 / §3.4). Deliberately a PROJECT column pair, not a per-row field: §3.5
   * forbids a set that is half in the user's account and half in Motir's, so the
   * target is ONE choice for the whole set — which is also what lets MOTIR-711's
   * transfer flow find every claimable repo of a project with one project-scoped
   * read instead of a GitHub account scan.
   *
   * `tx` REQUIRED; the caller (`projectRepoSetService`) has already resolved +
   * edit-gated the project and validated the account shape, so this is a plain
   * id-keyed update.
   */
  async setRepoSetOwnership(
    id: string,
    data: { ownership: ProjectRepoOwnership; targetAccount: string },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({
      where: { id },
      data: { repoSetOwnership: data.ownership, repoSetTargetAccount: data.targetAccount },
    });
  },

  /**
   * Record (or clear) the project's own GitHub Actions RUNNER GROUP — Story
   * MOTIR-1916 · MOTIR-1972, `docs/decisions/ci-runner-fleet.md` §7.3.
   *
   * `tx` REQUIRED, and the caller is expected to be holding this row's
   * {@link lockById} lock: the access list this stamps is READ-DERIVED (the
   * desired `selected_repository_ids` is computed from the project's current
   * repository set), so two rows establishing concurrently would otherwise each
   * read the pre-existing list and the second write would erase the first's
   * repository. The lock is what serializes them; this method is the plain
   * id-keyed write at the end of it.
   *
   * A single `data` object rather than four setters because the four fields are
   * ONE fact — "the group, and whether GitHub agrees with us about it" — and
   * writing them separately is what would let a successful sync leave
   * `runnerGroupSyncPending` true.
   */
  async setRunnerGroup(
    id: string,
    data: {
      runnerGroupId?: number | null;
      runnerGroupName?: string | null;
      runnerGroupSyncedAt?: Date | null;
      runnerGroupSyncPending?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Atomically bump the per-project work-item counter and return the new
   * value. Uses UPDATE … RETURNING (NOT a read-then-write) so allocation is
   * gap-free under concurrency: each concurrent caller's UPDATE serializes
   * on the row, and the RETURNING value is the post-increment number. The
   * counter is per-project (the WHERE clause keys on id) so two projects
   * never share or interfere with each other's numbering.
   */
  async allocateWorkItemNumber(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ n: number }>>`
      UPDATE "project" SET "lastWorkItemNumber" = "lastWorkItemNumber" + 1
      WHERE "id" = ${id} RETURNING "lastWorkItemNumber" AS n`;
    if (rows.length === 0) throw new ProjectNotFoundError(id);
    return Number(rows[0]!.n);
  },
};
