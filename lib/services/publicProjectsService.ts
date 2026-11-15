import type { Prisma } from '@/generated/prisma/client';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { publicAddressesService } from '@/lib/services/publicAddressesService';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { resolveStoredBoardFilter } from '@/lib/services/boardStoredFilter';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { triageService, type TriageSubmissionKind } from '@/lib/services/triageService';
import {
  withSystemContext,
  withUserContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { toCommentDto } from '@/lib/mappers/commentMappers';
import {
  toPublicChangelogEntryDto,
  toPublicProjectOverviewDto,
  toPublicRequestDetailDto,
  toPublicRequestMatchDto,
  toPublicRoadmapCardDto,
  toPublicWorkItemDetailDto,
  toPublicWorkItemDetailParentDto,
  toPublicWorkItemListItemDto,
  toPublicWorkItemTreeRowDto,
} from '@/lib/mappers/publicProjectsMappers';
import {
  MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH,
  PublicProjectIntakeUnavailableError,
  PublicRequestDescriptionTooLongError,
  PublicSubmissionRateLimitedError,
  PublicWorkItemNotFoundError,
} from '@/lib/publicProjects/errors';
import {
  decodeRoadmapCursor,
  encodeRoadmapCursor,
  InvalidRoadmapCursorError,
  PUBLIC_ROADMAP_PAGE_SIZE,
} from '@/lib/publicProjects/roadmapCursor';
import { publicSubmitBudget } from '@/lib/rateLimit/budgets';
import { rateLimitKey } from '@/lib/rateLimit/keys';
import { consumeSharedRateLimit } from '@/lib/rateLimit/limiter';
import { retryAfterSeconds } from '@/lib/api/v1/rateLimit';
import type {
  PublicChangelogCursor,
  PublicRoadmapCursor,
  PublicRoadmapRow,
} from '@/lib/repositories/workItemRepository';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  PublicBoardDto,
  PublicChangelogEntryDto,
  PublicChangelogPageDto,
  PublicDuplicateMatchesDto,
  PublicProjectIndexPageDto,
  PublicProjectOverviewDto,
  PublicProjectStatsDto,
  PublicRequestMatchDto,
  PublicRoadmapBucketKey,
  PublicRoadmapColumnDto,
  PublicRoadmapColumnPageDto,
  PublicRoadmapDto,
  PublicRequestDetailDto,
  PublicTreeLevelDto,
  PublicWorkItemDetailDto,
  PublicWorkItemDetailParentDto,
  PublicWorkItemPageDto,
} from '@/lib/dto/publicProjects';
import { PUBLIC_ROADMAP_BUCKET_KEYS } from '@/lib/dto/publicProjects';
import { decodeChangelogCursor, encodeChangelogCursor } from '@/lib/publicProjects/changelogCursor';
import { PUBLIC_NOT_SHIPPED_DONE_KEY } from '@/lib/publicProjects/shippedStatus';
import type { TriageSubmissionResultDto } from '@/lib/dto/triage';

// publicProjectsService — the SINGLE service behind every PUBLIC project surface
// (Story 6.12). It carries two concerns over the same 6.12.3 access gate:
//
//   * READ (Subtask 6.12.4) — the anonymous, crawlable `/p/[identifier]` view.
//     Every read method resolves the project, then calls
//     `projectAccessService.assertCanBrowsePublic` (anonymous READ allowed on a
//     public project; ProjectNotFoundError → 404 on a non-public one — the
//     single auditable cross-org branch, reused not re-derived). `actorUserId`
//     is NULLABLE (a logged-out visitor / a crawler). The reads return the
//     PUBLIC PROJECTION DTOs (lib/dto/publicProjects.ts), which structurally
//     lack assignees / estimates / story points / internal comments — so an
//     internal field can never leak (absent from the shape, not DOM-hidden).
//
//   * WRITE / dedupe (Subtask 6.12.5) — the cross-account "submit a request"
//     path (reusing the 6.11.4 triage intake — no second submissions table) +
//     the deterministic duplicate-detection pre-check (Canny's "upvote this
//     instead"). These REQUIRE a signed-in `actorUserId` (sign-in-to-act — the
//     route gates the session) and key off the GLOBAL project id (ADR §2.2 — the
//     workspace-scoped "PROD" identifier collides across workspaces). Gated by
//     `assertCanSubmitToTriage` (NOT `canEdit`).
//
// 4-layer: this service orchestrates repositories + sibling services and maps to
// DTOs; the read paths own no transactions, the write path delegates to
// `triageService.createSubmission` for its transaction. Routes parse + call ONE
// method each.

// --- READ (6.12.4) helpers -------------------------------------------------

/**
 * The public board's load cap — a board-level bound (the at-scale rule: never
 * "load every row"). Smaller than the internal board cap because the public
 * projection is a lightweight crawlable read, not the full working board.
 */
const PUBLIC_BOARD_CAP = 200;

/** The Work-items tab page size (cursor-paginated, lazy — the at-scale rule). */
const PUBLIC_WORK_ITEMS_PAGE_SIZE = 30;

/**
 * The public-project INDEX page size (MOTIR-4111). Larger than the work-item
 * page because each row is two short fields and the consumer is a sitemap
 * generator walking the WHOLE set — a small page there is just more round trips
 * for the same bytes. Still bounded: the set's size is the customer count.
 */
const PUBLIC_PROJECT_INDEX_PAGE_SIZE = 200;
/**
 * The public CHANGELOG's page size (Story 8.9 · Subtask 8.9.3 · ADR §3). Smaller
 * than the work-items list because a changelog entry is a read-and-move-on unit
 * with a date heading, not a row in a scan.
 */
const PUBLIC_CHANGELOG_PAGE_SIZE = 20;
/**
 * How many entries the Atom FEED carries (Story 8.9 · Subtask 8.9.6 · ADR §5).
 * Larger than a page and NOT paginated: feed readers do not page, and a feed
 * that grows without bound is one that eventually times out. A reader who wants
 * the whole history follows `<link rel="alternate">` to the page.
 */
const PUBLIC_CHANGELOG_FEED_SIZE = 50;

/**
 * The public TREE level page size (Subtask 6.14.10) — how many siblings one lazy
 * level loads at once before a "Load more children" affordance. Offset-paged per
 * level (the at-scale rule: a node's children load on expand, never the whole
 * forest up front), mirroring the authed lazy tree (2.5.13).
 */
const PUBLIC_TREE_PAGE_SIZE = 50;

/**
 * Resolve a public project by identifier + run the anonymous browse gate, AND
 * report whether the actor is a project MEMBER (Subtask 6.14.4 — the epic-privacy
 * exclusion keys off member-vs-non-member). One round-trip via
 * `projectAccessService.resolvePublicBrowse`.
 */
async function resolvePublicProject(identifier: string, actorUserId: string | null) {
  // A public project lives in exactly one workspace, but the identifier alone
  // doesn't name the workspace, so we can't use the workspace-scoped
  // `findByIdentifier` here. `findPublicByIdentifier` resolves the (single)
  // PUBLIC project carrying this key; the gate then confirms it is `public` (404
  // otherwise — no existence leak), so a non-public project carrying the same
  // key in another workspace stays hidden. (ADR §2.2 prefers id-addressing for
  // the public surface to avoid the cross-workspace key collision; 6.12.4 keeps
  // the pretty `/p/PROD` URL — the proper share token is 6.12.8. The collision
  // is a documented edge for the demo; flagged in the 6.12.4 PR body.)
  const project = await projectRepository.findPublicByIdentifier(identifier);
  if (!project) throw new ProjectNotFoundError(identifier);
  // The gate is the authority on visibility (it throws ProjectNotFoundError on a
  // non-public project) — reuse it, never re-derive the public check. It also
  // reports member-vs-non-member in the same round-trip (6.14.4).
  // The gate reports member-vs-non-member (6.14.4) AND whether the viewer may
  // manage the project (6.16.3 — the public page's in-place Edit gate) in the
  // same round-trip.
  const { isMember, canManage } = await projectAccessService.resolvePublicBrowse(
    project.id,
    actorUserId,
  );
  return { project, isMember, canManage };
}

/**
 * The epic-privacy exclusion set for a public read (Story 6.14 · Subtask 6.14.4)
 * — the ids of every descendant of a PRIVATE epic, which the projection must drop
 * so they never cross the wire to a non-member. A MEMBER viewer (or a project
 * with no private epic) gets `[]`, so the read stays byte-for-byte the prior
 * projection. Centralised here so EVERY public read that loads work items applies
 * the SAME predicate (the no-leak guarantee is one helper, not N filters); a new
 * public item read is wired by passing `excludeIds` from this one call.
 */
async function resolveHiddenIds(
  project: { id: string; workspaceId: string },
  isMember: boolean,
): Promise<string[]> {
  if (isMember) return [];
  return workItemRepository.findPublicHiddenDescendantIds(project.id, project.workspaceId);
}

/**
 * Compute the Overview stat strip from bounded counts (no per-item N+1).
 * `excludeIds` is the epic-privacy exclusion set (6.14.4): for a non-member the
 * Planned / In progress / Shipped counts must NOT count a private epic's hidden
 * descendants (counting them would leak the hidden subtree's size — an aggregate
 * tell). The triage / upvote counts are unaffected (a triage item is parentless,
 * so never a private epic's descendant).
 *
 * `tx` is the caller's transaction, ALREADY BOUND to `workspaceId`: the two bound
 * counts run on it one after the other, and the upvote count — deliberately
 * unbound, the RLS-secondary posture `countByProject` documents — runs beside them.
 */
async function computeStats(
  projectId: string,
  workspaceId: string,
  excludeIds: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<PublicProjectStatsDto> {
  // MOTIR-6627 — the two bound counts share the caller's ONE transaction rather
  // than opening one each. Each `withWorkspaceServiceContext` is a pool slot held
  // for the length of its read, and `getOverview` used to ask for three at once
  // (these two plus its workspace read) on every anonymous render: a handful of
  // concurrent renders drained the pool, and the next `$transaction` died at
  // Prisma's 2 s `maxWait` with "Unable to start a transaction in the given
  // time". The reads share one binding, so they are not the structural
  // exception `lib/workspaces/context.ts` allows this service.
  const countBound = async () => {
    // Bound (MOTIR-2789): this count JOINS `workflow_status` to resolve each item's
    // category, and that table has no public arm — so unbound the join matched nothing
    // and every stat read zero on a project full of work.
    const byCategory = await workItemRepository.countByStatusCategory(
      projectId,
      workspaceId,
      { excludeIds },
      tx,
    );
    const publicRequests = await workItemRepository.countTriageItems(projectId, workspaceId, tx);
    return { byCategory, publicRequests };
  };
  const [{ byCategory, publicRequests }, upvotes] = await Promise.all([
    countBound(),
    publicRequestVoteRepository.countByProject(projectId),
  ]);
  return {
    publicRequests,
    upvotes,
    // "Planned" = everything not yet shipped (todo + in_progress); "Shipped" =
    // the done category. "In progress" is surfaced separately on the sidebar.
    planned: byCategory.todo + byCategory.in_progress,
    shipped: byCategory.done,
    inProgress: byCategory.in_progress,
  };
}

// --- READ · ROADMAP (6.12.7) helpers ---------------------------------------

/**
 * The default terminal "cancelled" status key — EXCLUDED from the public
 * roadmap's Done bucket, for the reason `PUBLIC_NOT_SHIPPED_DONE_KEY` records
 * in full: a cancelled item is a resolved "won't do", so it is sealed-not-
 * shipped and never appears on a public surface.
 *
 * MOVED to `lib/publicProjects/shippedStatus.ts` (Story 8.9 · Subtask 8.9.3) so
 * the roadmap's Done bucket and the public CHANGELOG share ONE literal rather
 * than each carrying its own. The alias is kept because this file reads better
 * with the roadmap's own name for it, and because every citation of
 * `ROADMAP_EXCLUDED_DONE_KEY` still lands.
 */
const ROADMAP_EXCLUDED_DONE_KEY = PUBLIC_NOT_SHIPPED_DONE_KEY;

/**
 * Map the project's real workflow statuses to the three PROMOTED roadmap
 * buckets' status-key sets (the planner's "decide the mapping" call — rung 1,
 * the Canny/Productboard status-roadmap shape): `planned` = every `todo`-
 * category status (To&nbsp;Do, Blocked); `in_progress` = every `in_progress`-
 * category status (In&nbsp;Progress, In&nbsp;Review); `done` = every `done`-
 * category status EXCEPT `cancelled`. The fourth bucket (`submitted`) is the
 * in-triage public requests — it has no status-key set (a different read).
 */
function promotedRoadmapStatusKeys(
  statuses: WorkflowStatusDto[],
): Record<'planned' | 'in_progress' | 'done', string[]> {
  return {
    planned: statuses.filter((s) => s.category === 'todo').map((s) => s.key),
    in_progress: statuses.filter((s) => s.category === 'in_progress').map((s) => s.key),
    done: statuses
      .filter((s) => s.category === 'done' && s.key !== ROADMAP_EXCLUDED_DONE_KEY)
      .map((s) => s.key),
  };
}

/** The opaque next-page cursor for the last row of a roadmap column page. */
function nextRoadmapCursor(bucket: PublicRoadmapBucketKey, last: PublicRoadmapRow): string {
  // Submitted tiebreaks on `triagedAt` (non-null by the read's predicate);
  // every promoted bucket tiebreaks on the monotonic `key`.
  const recency =
    bucket === 'submitted' ? (last.triagedAt as Date).toISOString() : String(last.key);
  return encodeRoadmapCursor({ voteCount: last.voteCount, recency, id: last.id });
}

/** Decode + retype a column cursor for the bucket's seek-after comparison. */
function decodeRoadmapCursorForBucket(
  bucket: PublicRoadmapBucketKey,
  raw: string,
): PublicRoadmapCursor {
  const token = decodeRoadmapCursor(raw);
  if (bucket === 'submitted') {
    const d = new Date(token.recency);
    if (Number.isNaN(d.getTime())) throw new InvalidRoadmapCursorError();
    return { voteCount: token.voteCount, recency: d, id: token.id };
  }
  const n = Number(token.recency);
  if (!Number.isInteger(n)) throw new InvalidRoadmapCursorError();
  return { voteCount: token.voteCount, recency: n, id: token.id };
}

/**
 * Read ONE roadmap column's page (the at-scale `take + 1` over-fetch → derive
 * `nextCursor` without a trailing COUNT). `submitted` reads the active in-triage
 * public requests; the promoted buckets read graduated items in their mapped
 * status keys. Shared by the initial `getRoadmap` (all four) and the per-column
 * `getRoadmapColumn` "Load more". `voterUserId` (nullable) drives `voted`.
 */
async function loadRoadmapColumnPage(
  project: { id: string; workspaceId: string },
  bucket: PublicRoadmapBucketKey,
  promotedKeys: Record<'planned' | 'in_progress' | 'done', string[]>,
  actorUserId: string | null,
  excludeIds: readonly string[],
  cursor?: PublicRoadmapCursor,
): Promise<{ cards: PublicRoadmapColumnDto['cards']; nextCursor: string | null }> {
  const limit = PUBLIC_ROADMAP_PAGE_SIZE + 1;
  const rows =
    bucket === 'submitted'
      ? // Submitted = still-in-triage public requests; a triage item is parentless
        // so it can never descend from a private epic — no epic-privacy exclusion.
        await workItemRepository.findPublicRoadmapSubmitted(project.id, project.workspaceId, {
          limit,
          cursor,
          voterUserId: actorUserId,
        })
      : // Promoted buckets read graduated work items, which CAN be a private epic's
        // descendants — exclude them for a non-member (6.14.4).
        await workItemRepository.findPublicRoadmapByStatus(
          project.id,
          project.workspaceId,
          promotedKeys[bucket],
          { limit, cursor, voterUserId: actorUserId, excludeIds },
        );

  const hasMore = rows.length > PUBLIC_ROADMAP_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PUBLIC_ROADMAP_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  return {
    cards: page.map(toPublicRoadmapCardDto),
    nextCursor: hasMore && last ? nextRoadmapCursor(bucket, last) : null,
  };
}

/** The full-bucket count behind a column header (not the loaded-page length). */
async function countRoadmapColumn(
  project: { id: string; workspaceId: string },
  bucket: PublicRoadmapBucketKey,
  promotedKeys: Record<'planned' | 'in_progress' | 'done', string[]>,
  excludeIds: readonly string[],
): Promise<number> {
  return bucket === 'submitted'
    ? // Submitted bucket = parentless triage items; never a private epic's
      // descendant, so no epic-privacy exclusion (6.14.4).
      workItemRepository.countPublicRoadmapSubmitted(project.id, project.workspaceId)
    : workItemRepository.countProjectIssues(project.id, project.workspaceId, {
        statuses: promotedKeys[bucket],
        excludeIds,
      });
}

// --- WRITE / dedupe (6.12.5) helpers ---------------------------------------

// How many duplicate candidates the pre-check surfaces (bounded — never
// load-all; the UI shows the top matches as "upvote this instead").
const DUPLICATE_MATCH_LIMIT = 5;

/**
 * Throttle a submitting ACCOUNT — counted through the SHARED store
 * (MOTIR-2598): throw {@link PublicSubmissionRateLimitedError} once the account
 * has spent its {@link publicSubmitBudget}, otherwise let the submission
 * through. The second limb behind the IP-keyed `enforcePublicWriteRateLimit`
 * the route already runs; the two are additive by design.
 *
 * ⚠️ IT NO LONGER OWNS A COUNTER. This was a module-level
 * `Map<string, number[]>` sliding window and therefore per Node PROCESS: on
 * Fly's `machine_count: 2` an advertised 5 submissions per 10 minutes was
 * really 10. Subtask 8.5.9 (MOTIR-1165) landed one shared counter and left this
 * surface behind; this is the part that was skipped. The sliding→fixed-window
 * consequences are the same two documented on `attachmentsService`'s
 * `checkRateLimit`.
 *
 * **`Retry-After` now names the window's END, not the oldest attempt's expiry.**
 * The sliding window could answer "wait until your oldest of five ages out";
 * a fixed window has no per-attempt timestamps to derive that from, so the
 * answer is the seconds left in the current cell — computed by `/api/v1`'s
 * shipped `retryAfterSeconds`, the same helper every other 429 in the app uses.
 * Both are bounded by the window and never below 1, so the header stays a
 * truthful "wait at least this long"; only the shape of its value changes (it
 * ticks down to the same instant for every caller in a cell, rather than being
 * personal to each caller's history).
 */
async function checkSubmissionRateLimit(userId: string): Promise<void> {
  const decision = await consumeSharedRateLimit(
    rateLimitKey('public-submit', userId),
    publicSubmitBudget(),
  );
  if (!decision.allowed) {
    throw new PublicSubmissionRateLimitedError(retryAfterSeconds(decision));
  }
}

export const publicProjectsService = {
  // --- READ (6.12.4) -------------------------------------------------------

  /**
   * Every public project's `{ identifier, updatedAt }` (Subtask 6.12.4). No
   * gate: these are public by definition (the repo read constrains to
   * `accessMode = 'public'`). Cross-workspace, by design.
   *
   * ⚠️ Named for `app/sitemap.ts`, which is DELETED — MOTIR-3951 moved the
   * crawlable pages to `motir.co`, and MOTIR-4583 removed the route because an
   * empty `<urlset>` is schema-invalid. Its live consumer is
   * `publicFollowDigestService`; the name is kept because
   * `tests/rls/singleton-read-guard.test.ts` pins the read's verdict by it.
   */
  async listPublicForSitemap(): Promise<Array<{ identifier: string; updatedAt: Date }>> {
    return projectRepository.listPublic();
  },

  /**
   * One PAGE of the public-project INDEX (MOTIR-4111) — the crawl enumeration
   * `motir.co` reads to build its sitemap.
   *
   * ⚠️ WHY THIS EXISTS BESIDE {@link listPublicForSitemap} RATHER THAN REPLACING
   * IT. That method loads every public project at once, and its ONE caller is
   * `publicFollowDigestService`, which fans out per project inside a job — a
   * whole-set read is right there. This one is served over HTTP to a crawler on
   * another host, and its size is the CUSTOMER COUNT: unbounded by construction,
   * so it pages (finding #57 — a system-level list is never load-all).
   *
   * The page is ordered by `id`, not `updatedAt` — the repository's own note
   * carries the reasoning, and it is the reason a sitemap walk over this cannot
   * skip or duplicate a project. `nextCursor` is the last row's id, opaque to the
   * caller, exactly as the public work-items list already does it; null on the
   * last page.
   *
   * NO GATE, and none is possible or needed: every row is `accessMode = 'public'`
   * by the repository's own filter, which is the same reason
   * {@link listPublicForSitemap} has no gate. Cross-workspace by design — the
   * public directory lists every public project regardless of tenant.
   */
  async listPublicIndex(cursor?: string): Promise<PublicProjectIndexPageDto> {
    // Over-fetch one row to learn whether a next page exists, then trim — the
    // idiom `getWorkItems` uses, so the two pagers behave identically.
    const rows = await projectRepository.listPublicIndexPage({
      take: PUBLIC_PROJECT_INDEX_PAGE_SIZE + 1,
      cursor,
    });
    const hasMore = rows.length > PUBLIC_PROJECT_INDEX_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PUBLIC_PROJECT_INDEX_PAGE_SIZE) : rows;
    // The canonical HOST per row (Story MOTIR-3878 · the ADR §7). Resolved for
    // the page rather than per request: a sitemap builder asks for one page and
    // needs every row's host, so N sequential lookups would be the shape
    // `getOverview`'s own twenty-nine-await problem took.
    const hosts = await publicAddressesService.primaryHostsForProjects(
      page.map((row) => ({ id: row.id, workspaceId: row.workspaceId, identifier: row.identifier })),
    );
    return {
      projects: page.map((row) => ({
        identifier: row.identifier,
        updatedAt: row.updatedAt.toISOString(),
        primaryHost: hosts.get(row.id) ?? new URL(publicSiteOrigin()).host,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  },

  /**
   * The public Overview/README landing (Subtask 6.12.4). Resolves the project +
   * runs the anonymous gate, then returns the hero/meta + the authored
   * `publicOverviewMd` (null → the UI's slim auto-intro fallback) + the
   * at-a-glance stats + the public-safe Links. `actorUserId` nullable.
   */
  async getOverview(
    identifier: string,
    actorUserId: string | null,
  ): Promise<PublicProjectOverviewDto> {
    const { project, isMember, canManage } = await resolvePublicProject(identifier, actorUserId);
    const hiddenIds = await resolveHiddenIds(project, isMember);
    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // `resolvePublicProject` gated this read above; neither the workspace read
    // nor `computeStats` refuses.
    //
    // MOTIR-6627 — but every BOUND read here shares one binding (the project's own
    // workspace), so they share ONE transaction: one pool slot per render, not
    // three. `docs/decisions/bound-read-transaction-shape.md` is the rule; the
    // fan-out that stays is between that transaction and the reads that are
    // deliberately unbound.
    const [{ workspace, stats }, addresses] = await Promise.all([
      withWorkspaceServiceContext(project.workspaceId, async (tx) => {
        // `workspace` has no public arm either; the project's own workspace is known here.
        const workspace = await workspaceRepository.findById(project.workspaceId, tx);
        const stats = await computeStats(project.id, project.workspaceId, hiddenIds, tx);
        return { workspace, stats };
      }),
      // The project's canonical address and its alternates (Story MOTIR-3878 ·
      // the ADR §7). In the SAME `Promise.all` rather than awaited after it: it
      // is a peer read with no dependency on the bound reads, and the renderer
      // needs it on the first paint to emit a canonical.
      publicAddressesService.addressesForProject(
        project.id,
        project.workspaceId,
        project.identifier,
      ),
    ]);
    return toPublicProjectOverviewDto(project, workspace?.name ?? '', stats, canManage, addresses);
  },

  /**
   * Persist the public hero fields (tagline + tags + README body) FROM THE
   * PUBLIC PAGE — the save behind the on-page in-place editor (Story 6.16 ·
   * Subtask 6.16.5). The settings-area author (6.12.8) keys off the active
   * project cookie; the public `/p/<identifier>` page can be open while a
   * DIFFERENT project is active, so this entry point keys off the public
   * `identifier` instead and resolves the project's workspace itself.
   *
   * Admin-gated TWICE — defense in depth: the public browse gate already reports
   * `canManage` (admin-only; anonymous / cross-org → false), and we reject a
   * non-admin here with `NotProjectAdminError` (→ the action's 403) BEFORE any
   * write; the delegated `projectsService.setPublicOverview` then re-runs its own
   * `assertCanManage` inside the write transaction. A partial author: each field
   * is optional (absent = untouched), validation + normalization live in the
   * delegate (the single source of truth for the field rules). `actorUserId` is
   * nullable — an anonymous caller never resolves `canManage`, so it 403s.
   */
  async setPublicOverview(
    identifier: string,
    actorUserId: string | null,
    input: {
      publicOverviewMd?: string;
      publicTagline?: string | null;
      publicTags?: string[];
    },
  ): Promise<void> {
    const { project, canManage } = await resolvePublicProject(identifier, actorUserId);
    if (!canManage || actorUserId === null) throw new NotProjectAdminError(project.id);
    await projectsService.setPublicOverview({
      key: identifier,
      ctx: { userId: actorUserId, workspaceId: project.workspaceId },
      publicOverviewMd: input.publicOverviewMd,
      publicTagline: input.publicTagline,
      publicTags: input.publicTags,
    });
  },

  /**
   * The public read-only BOARD (Subtask 6.12.4) — the project's default board
   * projected through the PUBLIC mapper: each card carries ONLY kind / key /
   * identifier / title / status / priority (NO assignee, estimate, or story
   * points). Triage + archived items are excluded by the repository read.
   * Bounded by `PUBLIC_BOARD_CAP` (the at-scale rule). Returns an empty board
   * (no columns) when the project has no default board yet — the public UI shows
   * its empty state rather than 404ing a browsable project. `actorUserId`
   * nullable.
   */
  async getBoard(identifier: string, actorUserId: string | null): Promise<PublicBoardDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const { id: projectId, workspaceId } = project;
    // Epic-privacy (6.14.4): a non-member never receives a private epic's
    // descendants — the cards AND the per-column denominators exclude them; the
    // private epic card itself is marked `childrenHidden` (the mapper).
    const hiddenIds = await resolveHiddenIds(project, isMember);

    // BOUND (MOTIR-2789). MOTIR-2684 gave a public arm to `project` and `work_item` only;
    // `board`, `board_column`, `board_column_status` and `workflow_status` never got one,
    // so every one of these reads came back empty and the public board rendered as a
    // project with no columns — the 404 this card's predecessor fixed became a blank page
    // one table over.
    //
    // Binding rather than four more policy arms, and MOTIR-2684's own reasoning is why:
    // it needed an arm for `project` because "the workspace is the PROJECT'S own — which
    // is the very thing the read resolves, so binding it would presume the answer". That
    // chicken-and-egg holds ONLY for the reads that come BEFORE the workspace is known.
    // Here `resolvePublicProject` has already returned it, so there is something honest
    // to bind, and binding the project's own workspace is not the cross-tenant widening
    // that migration rejected `withSystemContext` for.
    //
    // MOTIR-6653 — the board lookup and the three reads of the board it resolves
    // share one binding (the project's own workspace), so they share ONE
    // transaction, run one after the other: one pool slot per render, not four.
    // They used to be a `Promise.all` of three `withWorkspaceServiceContext`s, the
    // shape MOTIR-6627 removed from `getOverview` after it drained the pool —
    // `docs/decisions/bound-read-transaction-shape.md` is the rule.
    const loaded = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const board = await boardRepository.findDefaultForProject(projectId, workspaceId, tx);
      if (!board) return null;
      const columns = await boardColumnRepository.findByBoard(board.id, workspaceId, tx);
      const mappings = await boardColumnStatusRepository.findByBoard(board.id, workspaceId, tx);
      const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId, tx);
      return { board, columns, mappings, statuses };
    });
    if (!loaded) {
      return { boardId: '', name: '', columns: [], cap: PUBLIC_BOARD_CAP, truncated: false };
    }
    const { board, columns, mappings, statuses } = loaded;
    // The default board's OWN stored filter (MOTIR-10560): the preview shows the
    // same cards and counts the board does, with the same never-throwing
    // resolution (a stale condition matches nothing, an unreadable filter
    // narrows the board to nothing). `undefined` ⇒ today's reads exactly.
    const storedFilter = (await resolveStoredBoardFilter(projectId, workspaceId, board.filter))
      ?.predicate;

    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));
    const terminalKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));

    // column id → its mapped LIVE statuses (a mapping to a deleted status is
    // skipped — no live key).
    const liveByColumn = new Map<string, WorkflowStatusDto[]>();
    for (const m of mappings) {
      const s = statusById.get(m.statusId);
      if (!s) continue;
      const list = liveByColumn.get(m.columnId) ?? [];
      list.push(s);
      liveByColumn.set(m.columnId, list);
    }

    let boardTotal = 0;
    const builtColumns = await Promise.all(
      columns.map(async (col) => {
        const live = (liveByColumn.get(col.id) ?? [])
          .slice()
          .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
        const statusKeys = live.map((s) => s.key);
        if (statusKeys.length === 0) {
          return {
            id: col.id,
            name: col.name,
            statusKeys,
            cards: [],
            totalCount: 0,
          };
        }
        // A terminal (done) column ranks by recency; an active column by board
        // rank — same ordering the internal board uses, minus the Done-age
        // window (the public projection shows the most recent shipped work).
        const terminal = statusKeys.every((k) => terminalKeys.has(k));
        const [rows, totalCount] = await Promise.all([
          workItemRepository.findColumnCards(
            projectId,
            workspaceId,
            statusKeys,
            terminal ? 'recent' : 'position',
            {
              limit: PUBLIC_BOARD_CAP,
              excludeIds: hiddenIds,
              ...(storedFilter ? { storedFilter } : {}),
            },
          ),
          workItemRepository.countProjectIssues(projectId, workspaceId, {
            statuses: statusKeys,
            excludeIds: hiddenIds,
            ...(storedFilter ? { storedFilter } : {}),
          }),
        ]);
        boardTotal += totalCount;
        return {
          id: col.id,
          name: col.name,
          statusKeys,
          cards: rows.map((r) =>
            toPublicWorkItemListItemDto(r, categoryByKey.get(r.status) ?? 'todo', {
              hideChildren: !isMember,
            }),
          ),
          totalCount,
        };
      }),
    );

    return {
      boardId: board.id,
      name: board.name,
      columns: builtColumns,
      cap: PUBLIC_BOARD_CAP,
      truncated: boardTotal > PUBLIC_BOARD_CAP,
    };
  },

  /**
   * The public CHANGELOG tab (Story 8.9 · Subtask 8.9.3 ·
   * `docs/decisions/public-follow-and-changelog.md`) — the project's shipped
   * items, newest first, cursor-paged. The one PUSH surface's read; the Atom
   * feed (8.9.6) and the follower digest (8.9.7) compose the SAME method, which
   * is what makes their privacy behaviour identical by construction rather than
   * by three parallel filters.
   *
   * PRIVACY. `resolveHiddenIds` supplies the 6.14 private-epic descendant set
   * exactly as every other public read does, and the repository read adds the
   * predicate that set does NOT cover: a private epic's OWN row. That row stays
   * visible in the TREE as the "this epic is not public" placeholder, which is
   * right for a tree and wrong for a stream — a changelog entry asserts that a
   * specific thing shipped, and there is no placeholder entry. Without it, a
   * private epic reaching `done` would publish its title into a feed.
   *
   * ⚠️ THE DIGEST MUST RE-READ THIS AT SEND TIME, not at follow time: an epic
   * made private on Wednesday must not appear in Monday's mail because it was
   * public when the item shipped.
   *
   * Over-fetches one row to derive `nextCursor` without a trailing COUNT — the
   * convention `getWorkItems` sets directly below. `actorUserId` nullable: the
   * page is anonymous, and a MEMBER simply gets an empty exclusion set.
   */
  async getChangelog(
    identifier: string,
    actorUserId: string | null,
    cursor?: string,
  ): Promise<PublicChangelogPageDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const hiddenIds = await resolveHiddenIds(project, isMember);

    // A malformed cursor throws rather than restarting from the top — a pager
    // that silently repeats its first page is far harder to notice than a 400.
    const seek: PublicChangelogCursor | undefined = cursor
      ? (() => {
          const token = decodeChangelogCursor(cursor);
          return { shippedAt: new Date(token.shippedAt), key: token.key };
        })()
      : undefined;

    // ⚠️ BOUND, and this read is the reason. Every other public read runs
    // UNBOUND — `project` and `work_item` each carry a `*_public_project_read`
    // arm that fires only on a context-less connection, which is exactly the
    // anonymous path. The changelog joins a THIRD table, `work_item_revision`,
    // and its only policy (`work_item_revision_active_workspace`) requires a
    // bound `app.workspace_id`. Unbound, the join contributes no rows and the
    // read returns an EMPTY CHANGELOG — silently, with no error, on every
    // anonymous request. That is the same second-hop failure
    // `20260815200000_public_project_join_read_policies` traced for four other
    // public reads.
    //
    // The repair is to BIND rather than to widen. An anonymous SELECT arm on
    // `work_item_revision` would expose every field diff of every public
    // project's whole trail — far more than a changelog needs — whereas the
    // workspace is known here: `resolvePublicProject` just resolved it from the
    // public identifier and confirmed the project is `public`, which is the
    // trusted resolution `withWorkspaceServiceContext` documents as its
    // precondition. It binds `app.workspace_id` and nothing else — no
    // `app.user_id`, no `app.system_admin` — so the reach stays row-scoped to
    // the one project's tenant. (The `/explore` square is the case where this
    // is NOT available: it is cross-tenant by construction, so it needs the
    // unbound arm. One known project is the opposite situation.)
    const rows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.findPublicChangelogEntries(
        project.id,
        project.workspaceId,
        { take: PUBLIC_CHANGELOG_PAGE_SIZE + 1, cursor: seek },
        hiddenIds,
        tx,
      ),
    );
    const hasMore = rows.length > PUBLIC_CHANGELOG_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PUBLIC_CHANGELOG_PAGE_SIZE) : rows;
    const last = page[page.length - 1];
    return {
      entries: page.map(toPublicChangelogEntryDto),
      nextCursor:
        hasMore && last
          ? encodeChangelogCursor({ shippedAt: last.shippedAt.toISOString(), key: last.key })
          : null,
    };
  },

  /**
   * The changelog as a FEED (Story 8.9 · Subtask 8.9.6) — the anonymous tier.
   *
   * Composes the SAME read as `getChangelog`, which is what makes the feed's
   * privacy behaviour identical to the page's by construction rather than by a
   * second set of filters: one exclusion set, one shipped-status definition, one
   * private-epic-row predicate. The two differ in exactly two ways, both from
   * ADR §5 — the feed takes 50 entries in one shot rather than a page of 20,
   * and it asks for each item's body, because a feed reader shows one.
   */
  async getChangelogFeed(
    identifier: string,
    actorUserId: string | null,
  ): Promise<{
    project: { identifier: string; name: string };
    /**
     * The project's CANONICAL base URL (MOTIR-4222 · ADR §7's rung 1, which says
     * in terms that the primary "is the address the product itself emits
     * everywhere", not only what a `<head>` says).
     *
     * The feed is built HERE and forwarded byte-for-byte by `motir.co`
     * (`motir-marketing`'s `changelog.xml` route explains why it must not
     * re-serialise the document), so this is the only place a feed's links can
     * learn where the project's canonical lives.
     */
    canonicalBase: string;
    entries: PublicChangelogEntryDto[];
  }> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const hiddenIds = await resolveHiddenIds(project, isMember);
    const rows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.findPublicChangelogEntries(
        project.id,
        project.workspaceId,
        { take: PUBLIC_CHANGELOG_FEED_SIZE, withDescription: true },
        hiddenIds,
        tx,
      ),
    );
    const addresses = await publicAddressesService.addressesForProject(
      project.id,
      project.workspaceId,
      project.identifier,
    );
    return {
      project: { identifier: project.identifier, name: project.name },
      canonicalBase: addresses.primary,
      entries: rows.map(toPublicChangelogEntryDto),
    };
  },

  /**
   * The public WORK ITEMS tab (Subtask 6.12.4) — a cursor-paginated, read-only
   * list of public-safe work items (same stripped projection as the board).
   * Triage + archived items are excluded by the repository read. `cursor` is an
   * opaque work-item id; `nextCursor` is null at the end of the list.
   * `actorUserId` nullable.
   */
  async getWorkItems(
    identifier: string,
    actorUserId: string | null,
    cursor?: string,
  ): Promise<PublicWorkItemPageDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));
    // Epic-privacy (6.14.4): a non-member's list excludes a private epic's
    // descendants server-side; the private epic row stays, marked.
    const hiddenIds = await resolveHiddenIds(project, isMember);

    // Over-fetch one row to detect whether a next page exists, then trim.
    const rows = await workItemRepository.findByProject(project.id, {
      take: PUBLIC_WORK_ITEMS_PAGE_SIZE + 1,
      cursor,
      excludeIds: hiddenIds,
    });
    const hasMore = rows.length > PUBLIC_WORK_ITEMS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PUBLIC_WORK_ITEMS_PAGE_SIZE) : rows;
    return {
      items: page.map((r) =>
        toPublicWorkItemListItemDto(r, categoryByKey.get(r.status) ?? 'todo', {
          hideChildren: !isMember,
        }),
      ),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  },

  /**
   * One lazy LEVEL of the public, expandable work-item TREE (Story 6.14 ·
   * Subtask 6.14.10) — the project's ROOTS (`parentId === null`, the SSR'd first
   * level of the Tree tab) or one parent's DIRECT children (fetched on expand).
   * The hierarchy is loaded a level at a time (the at-scale rule — never the
   * whole forest), offset-paged within each level. Returns the public projection
   * (stripped of assignee / estimate / story points) plus the lazy `hasChildren`
   * chevron flag + the level's full `total`.
   *
   * Epic-privacy (6.14.4): a non-member's level EXCLUDES every descendant of a
   * private epic — server-side, from both the rows AND the `hasChildren` probe
   * AND the `total` denominator (so the hidden subtree's size never leaks). The
   * private epic ROW itself stays, marked `childrenHidden` (the placeholder UI
   * reads that). A MEMBER (or a project with no private epic) reads the full
   * tree. Even a direct child-level fetch for a private epic returns `[]` (its
   * descendants are excluded) — defence-in-depth behind the marker-driven UI.
   * `actorUserId` nullable (a logged-out visitor / crawler).
   */
  async getProjectTreeLevel(
    identifier: string,
    parentId: string | null,
    actorUserId: string | null,
    offset = 0,
  ): Promise<PublicTreeLevelDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));
    const hiddenIds = await resolveHiddenIds(project, isMember);

    const [rows, total] = await Promise.all([
      // Over-fetch one row to detect a next page without a second COUNT.
      workItemRepository.findPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        parentId,
        { take: PUBLIC_TREE_PAGE_SIZE, offset },
        hiddenIds,
      ),
      workItemRepository.countPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        parentId,
        hiddenIds,
      ),
    ]);
    const hasMore = rows.length > PUBLIC_TREE_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PUBLIC_TREE_PAGE_SIZE) : rows;
    return {
      rows: page.map((r) =>
        toPublicWorkItemTreeRowDto(r, categoryByKey.get(r.status) ?? 'todo', {
          hideChildren: !isMember,
        }),
      ),
      hasMore,
      total,
    };
  },

  /**
   * The public ROADMAP (Subtask 6.12.7) — the project's public-facing items as
   * four status-grouped, vote-counted, per-column-paginated columns
   * (**Submitted → Planned → In progress → Done**), over the 6.12.4 public
   * projection. Resolves the project + runs the anonymous browse gate
   * (`actorUserId` nullable — a logged-out reader / crawler), then loads the
   * FIRST page + the full count of each column in parallel. The Submitted column
   * is the still-in-triage public requests (the demand-gathering bucket the ADR
   * §4 routes triage items to); the promoted columns map the project's real
   * workflow statuses to their buckets (cancelled excluded from Done). Every
   * card carries its upvote count (the demand signal the column orders by) and
   * the viewer's `voted` flag. Nothing internal leaks — the rows go through the
   * public projection mapper. `actorUserId` nullable.
   */
  async getRoadmap(identifier: string, actorUserId: string | null): Promise<PublicRoadmapDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const promotedKeys = promotedRoadmapStatusKeys(statuses);
    // Epic-privacy (6.14.4): a non-member's roadmap excludes a private epic's
    // descendants from both the promoted-bucket cards and their header counts.
    const hiddenIds = await resolveHiddenIds(project, isMember);

    const columns = await Promise.all(
      PUBLIC_ROADMAP_BUCKET_KEYS.map(async (bucket): Promise<PublicRoadmapColumnDto> => {
        const [page, totalCount] = await Promise.all([
          loadRoadmapColumnPage(project, bucket, promotedKeys, actorUserId, hiddenIds),
          countRoadmapColumn(project, bucket, promotedKeys, hiddenIds),
        ]);
        return { key: bucket, totalCount, cards: page.cards, nextCursor: page.nextCursor };
      }),
    );

    return { columns };
  },

  /**
   * One roadmap column's NEXT page (Subtask 6.12.7) — the per-column "Load more"
   * fetch behind the client island. Re-resolves the project + the anonymous gate
   * (a non-public project 404s here too), re-derives the bucket's status keys,
   * decodes the opaque column cursor, and returns the next page + the following
   * cursor. A malformed cursor throws `InvalidRoadmapCursorError` (→ 400). No
   * total count — the header already has it from `getRoadmap`. `actorUserId`
   * nullable.
   */
  async getRoadmapColumn(
    identifier: string,
    actorUserId: string | null,
    bucket: PublicRoadmapBucketKey,
    cursorRaw: string,
  ): Promise<PublicRoadmapColumnPageDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const cursor = decodeRoadmapCursorForBucket(bucket, cursorRaw);
    // Only the promoted buckets consult the status-key map; submitted ignores it,
    // so deriving the keys only when needed avoids a status read for Submitted.
    const promotedKeys =
      bucket === 'submitted'
        ? { planned: [], in_progress: [], done: [] }
        : promotedRoadmapStatusKeys(
            await workflowsService.listStatusesByProject(project.id, project.workspaceId),
          );
    // Epic-privacy (6.14.4): the submitted bucket needs no exclusion (parentless
    // triage items); a promoted bucket excludes a non-member's hidden subtree.
    const hiddenIds = bucket === 'submitted' ? [] : await resolveHiddenIds(project, isMember);
    const page = await loadRoadmapColumnPage(
      project,
      bucket,
      promotedKeys,
      actorUserId,
      hiddenIds,
      cursor,
    );
    return { bucket, cards: page.cards, nextCursor: page.nextCursor };
  },

  // --- READ · REQUEST DETAIL (6.12.12) -------------------------------------

  /**
   * The public request DETAIL (Subtask 6.12.12 · design Panel 5) — the read
   * behind `/p/<project>/requests/<request>`. Resolves the public project + runs
   * the anonymous browse gate (a non-public / unknown project 404s, never 403),
   * then resolves the request WITHIN that project by its work-item identifier
   * (e.g. "PROD-42"). A missing / cross-project / archived item is a
   * {@link PublicRequestNotFoundError} (the 404-not-403 posture — no existence
   * leak); a still-in-triage request IS shown (a roadmap "Submitted" card links
   * here). Epic-privacy (6.14.4): a non-member NEVER reaches a private epic's
   * hidden descendant — it 404s exactly like a missing item (the same no-leak
   * predicate the list/board/roadmap reads apply). Returns the public projection
   * PLUS the body, the status label, the upvote tally + the viewer's `voted`
   * flag, the opened-by name, and the PUBLIC comment thread (the request's
   * `isPublic` comments only — the work item's internal Story-5.1 discussion
   * never crosses the projection). `actorUserId` nullable (anonymous read; only
   * `voted` and the composer need a session).
   *
   * RLS context mirrors the 6.12.6 toggle: the cross-account vote COUNT reads
   * under `withSystemContext` (it spans every voter), the viewer's own `voted`
   * probe under `withUserContext` (it touches only their row). The work-item /
   * comment / user reads ride the app-layer projectId gate the rest of the
   * public read path uses.
   */
  async getRequestDetail(
    identifier: string,
    requestIdentifier: string,
    actorUserId: string | null,
  ): Promise<PublicRequestDetailDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);

    const item = await workItemRepository.findByIdentifier(project.id, requestIdentifier);
    // 404-not-403: a missing item, an item in another project, or an archived
    // (soft-deleted) one is hidden exactly like a non-public project.
    if (!item || item.archivedAt !== null) {
      throw new PublicRequestNotFoundError(requestIdentifier);
    }
    // Epic-privacy (6.14.4): a non-member must not reach a private epic's hidden
    // descendant — treat it as not-found (no leak), consistent with the other
    // public reads' exclusion set.
    const hiddenIds = await resolveHiddenIds(project, isMember);
    if (hiddenIds.includes(item.id)) {
      throw new PublicRequestNotFoundError(requestIdentifier);
    }

    // Status label + category for the Pill — the project's live workflow.
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const status = statuses.find((s) => s.key === item.status) ?? null;

    // The upvote tally spans every account (system context); the viewer's own
    // voted flag is their single row (user context), only when signed in.
    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // Every gate is awaited above (the project, the item, the privacy exclusion),
    // and neither arm refuses; the signed-out branch is a resolved `false`. This
    // site is NOT in the card's own scan: its arms open `withSystemContext` /
    // `withUserContext`, which that pattern does not name — see the PR body.
    const [voteCount, voted] = await Promise.all([
      withSystemContext((tx) => publicRequestVoteRepository.countByWorkItem(item.id, tx)),
      actorUserId
        ? withUserContext(actorUserId, (tx) =>
            publicRequestVoteRepository.findByWorkItemAndUser(item.id, actorUserId, tx),
          ).then((row) => row !== null)
        : Promise.resolve(false),
    ]);

    // "Opened by" — the real submitter (a 6.12 non-member, when present) else
    // the tenant reporter. The PUBLIC comment thread (isPublic only).
    const openedById = item.submittedByUserId ?? item.reporterId;
    // Bound to the project's workspace (MOTIR-2784). `comment` has no public policy
    // arm, so this read must name its tenant or it comes back empty and the thread
    // silently disappears. `withWorkspaceServiceContext` binds the workspace tier
    // alone, which is right here: a public reader has no actor.
    const commentRows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      commentRepository.listPublicByWorkItem(item.id, tx),
    );
    const userIds = [...new Set([openedById, ...commentRows.map((c) => c.authorId)])];
    const users = await userRepository.findByIds(userIds);
    const usersById = new Map(users.map((u) => [u.id, u]));
    // Public-request comments carry no mention scoping (6.12.6), so an empty
    // mention map is correct — never a leak of an internal mention set.
    const comments = commentRows.map((row) => toCommentDto(row, usersById, new Map()));

    return toPublicRequestDetailDto(item, {
      statusLabel: status?.label ?? item.status,
      statusCategory: status?.category ?? 'todo',
      openedByName: usersById.get(openedById)?.name ?? '',
      voteCount,
      voted,
      comments,
    });
  },

  // --- READ · WORK-ITEM DETAIL (6.14.11) -----------------------------------

  /**
   * The public read-only WORK-ITEM DETAIL (Story 6.14 · Subtask 6.14.11 · design
   * `public-item-detail.mock.html`) — the read behind `/p/<project>/items/<key>`,
   * the page a public / non-member viewer lands on from an items-list row or a
   * board card. Resolves the public project + runs the anonymous browse gate (a
   * non-public / unknown project 404s, never 403), then resolves the work item
   * WITHIN that project by its identifier (e.g. "PROD-42"). It returns the public
   * projection PLUS the body, the resolved status label, the immediate parent,
   * and the FIRST page of public-safe direct children (the rest lazy-load via the
   * public tree endpoint — the at-scale rule).
   *
   * Not-found posture (404-not-403, no existence leak): a missing /
   * cross-project / archived item, a TRIAGE item (it lives in the inbox, not the
   * planned tree — its public surface is the REQUEST detail, not this one), and a
   * private epic's HIDDEN descendant (a non-member must never reach it) all throw
   * {@link PublicWorkItemNotFoundError} — exactly like the request-detail read.
   *
   * Epic-privacy (Subtask 6.14.4): a NON-MEMBER viewing a PRIVATE epic gets the
   * `childrenHidden` marker (the child panel renders the "not public" statement,
   * the sidebar rollups read "Hidden"); its descendants are excluded server-side
   * (`children` empty, `childCount` 0) — defence-in-depth behind the marker. A
   * MEMBER (or a project with no private epic) reads the full child set.
   * `actorUserId` nullable (anonymous read / crawler).
   */
  async getWorkItemDetail(
    identifier: string,
    itemIdentifier: string,
    actorUserId: string | null,
  ): Promise<PublicWorkItemDetailDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);

    const item = await workItemRepository.findByIdentifier(project.id, itemIdentifier);
    // 404-not-403: a missing / cross-project item, an archived (soft-deleted)
    // one, or a triage item (not graduated to the planned tree) is hidden exactly
    // like a non-public project — the same exclusions the list / board / tree
    // reads apply (`triagedAt IS NULL`, `archivedAt IS NULL`).
    if (!item || item.archivedAt !== null || item.triagedAt !== null) {
      throw new PublicWorkItemNotFoundError(itemIdentifier);
    }
    // Epic-privacy (6.14.4): a non-member must not reach a private epic's hidden
    // descendant — treat it as not-found (no leak), consistent with every other
    // public read's exclusion set. (The private epic's OWN row stays reachable —
    // it is the visible placeholder; only its DESCENDANTS are in `hiddenIds`.)
    const hiddenIds = await resolveHiddenIds(project, isMember);
    if (hiddenIds.includes(item.id)) {
      throw new PublicWorkItemNotFoundError(itemIdentifier);
    }

    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const status = statuses.find((s) => s.key === item.status) ?? null;
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));

    // The placeholder marker: a non-member viewing a PRIVATE epic sees the "not
    // public" statement instead of children + "Hidden" sidebar rollups.
    const childrenHidden = !isMember && item.kind === 'epic' && item.publicChildrenHidden;

    // The immediate parent (the breadcrumb + sidebar "Parent" link). The item is
    // reachable, so its parent chain is public-safe — a parent that were a hidden
    // descendant (or the private epic itself) would have 404'd the item above.
    let parent: PublicWorkItemDetailParentDto | null = null;
    if (item.parentId) {
      // ⚠️ DELIBERATELY UNBOUND (MOTIR-2807), and the one call site of this read
      // that must stay so. `work_item_public_project_read` (MOTIR-2684) admits a
      // row only when `app.workspace_id` is UNSET —
      // `coalesce(current_setting('app.workspace_id', true), '') = ''` — so
      // opening a workspace context here would switch OFF the arm that makes the
      // public page work and leave the read depending on the private arm instead.
      // It would very likely still return the row (the project's own workspace
      // would match), which is what makes it dangerous: the public path would
      // silently stop being exercised, and a later change to the public policy
      // would break the page with nothing to catch it. Carried as `public-arm`
      // in `tests/rls/call-site-guard.test.ts`, pinned to this file.
      const [parentRow] = await workItemRepository.findByIds([item.parentId]);
      if (parentRow) parent = toPublicWorkItemDetailParentDto(parentRow);
    }

    // The first page of public-safe direct children + the full count (the
    // at-scale rule — the panel lazily loads the rest via the public tree
    // endpoint, `?parentId=<item.id>`). For a private-epic non-member, `hiddenIds`
    // already EXCLUDES the children, so this returns []/0 behind the marker.
    const [childRows, childCount] = await Promise.all([
      workItemRepository.findPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        item.id,
        { take: PUBLIC_TREE_PAGE_SIZE, offset: 0 },
        hiddenIds,
      ),
      workItemRepository.countPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        item.id,
        hiddenIds,
      ),
    ]);
    const childrenHasMore = childRows.length > PUBLIC_TREE_PAGE_SIZE;
    const childPage = childrenHasMore ? childRows.slice(0, PUBLIC_TREE_PAGE_SIZE) : childRows;

    return toPublicWorkItemDetailDto(item, {
      statusLabel: status?.label ?? item.status,
      statusCategory: status?.category ?? 'todo',
      parent,
      childrenHidden,
      childCount,
      children: childPage.map((r) =>
        toPublicWorkItemTreeRowDto(r, categoryByKey.get(r.status) ?? 'todo', {
          hideChildren: !isMember,
        }),
      ),
      childrenHasMore,
    });
  },

  // --- WRITE / dedupe (6.12.5) ---------------------------------------------

  /**
   * Duplicate-detection pre-check (Subtask 6.12.5) — given a draft title, return
   * the matching EXISTING active public requests so the UI can offer "upvote
   * this instead" before a dupe is created (Canny's core behaviour). Gated by
   * `canSubmitToTriage` (a signed-in actor on a PUBLIC project; a non-public
   * project reads as 404, no existence leak). Deterministic (a tokenised title
   * match over the project's public requests — NOT an AI call; AI dedupe is an
   * Epic-7 enhancement) and bounded. A blank draft short-circuits to no
   * candidates.
   */
  async findDuplicateRequests(
    projectId: string,
    actorUserId: string,
    draftTitle: string,
  ): Promise<PublicDuplicateMatchesDto> {
    const title = draftTitle.trim();
    if (title.length === 0) return { candidates: [] };

    // The gate: a non-public project is 404 (no existence leak); the grant is
    // true for any signed-in account on a public project. The route has already
    // ensured a session, so `actorUserId` is a real account.
    await projectAccessService.assertCanSubmitToTriage(projectId, actorUserId);

    const rows = await workItemRepository.findPublicRequestMatches(
      projectId,
      title,
      DUPLICATE_MATCH_LIMIT,
    );
    const candidates: PublicRequestMatchDto[] = rows.map(toPublicRequestMatchDto);
    return { candidates };
  },

  /**
   * Submit a request into a PUBLIC project's triage (Subtask 6.12.5) — the
   * cross-account "report a bug / request a feature" path. Reuses the 6.11.4
   * intake authority (`triageService.createSubmission` → `workItemsService`):
   * the submission is born a triage `work_item` (kind `bug`/`task`), EXCLUDED
   * from every normal read until an admin promotes it, attributed to the
   * submitting cross-org account via `submittedByUserId` while the project's
   * workspace owner stands in as the (member) `reporterId`. Gated by
   * `canSubmitToTriage` (NOT `canEdit`); rate-limited + size-capped (an
   * internet-facing write). Returns the thin submission confirmation.
   */
  async submitPublicRequest(
    projectId: string,
    submitterUserId: string,
    input: { kind: TriageSubmissionKind; title: string; descriptionMd?: string | null },
  ): Promise<TriageSubmissionResultDto> {
    // Size cap (the abuse guard; the title bound + the kind are validated by
    // `createSubmission` downstream).
    if (
      typeof input.descriptionMd === 'string' &&
      input.descriptionMd.length > MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH
    ) {
      throw new PublicRequestDescriptionTooLongError();
    }

    // Gate FIRST (a non-public project / denied grant rejects before any quota
    // is consumed), then throttle the legit public submitter.
    await projectAccessService.assertCanSubmitToTriage(projectId, submitterUserId);
    await checkSubmissionRateLimit(submitterUserId);

    // Resolve the project row for its workspace + identifier (the gate proved it
    // exists and is public). The intake reporter is the workspace OWNER — a
    // guaranteed member who passes `createWorkItem`'s `assertReporterMember`.
    // The project read needs no context: MOTIR-2684's `project_public_read` arm admits
    // `access_mode = 'public'`, which is exactly this path.
    const project = await projectRepository.findById(projectId);
    if (!project) throw new PublicProjectIntakeUnavailableError(projectId);
    // The OWNER read does (MOTIR-2789). `workspace_membership` got NO public arm from
    // MOTIR-2684 — only `project` and `work_item` did — so unbound this returned null
    // and the intake raised `PublicProjectIntakeUnavailableError`, which reads as "this
    // project has no owner" about a project that has one. There IS something honest to
    // bind here, unlike the project read above: the workspace is known from the row we
    // just resolved, so no policy work is needed. Workspace-tier only, because a public
    // submitter is cross-org and is not the actor whose membership is being read.
    const owner = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workspaceMembershipRepository.findStandInManagerByWorkspace(project.workspaceId, tx),
    );
    if (!owner) throw new PublicProjectIntakeUnavailableError(projectId);

    // Reuse the shared triage-create authority. `ctx` carries the intake
    // reporter (owner — a member); `submittedByUserId` carries the real
    // cross-org submitter (the 6.11.4 seam).
    return triageService.createSubmission(
      {
        projectKey: project.identifier,
        kind: input.kind,
        title: input.title,
        descriptionMd: input.descriptionMd ?? null,
        submittedByUserId: submitterUserId,
      },
      { userId: owner.userId, workspaceId: project.workspaceId },
    );
  },
};
