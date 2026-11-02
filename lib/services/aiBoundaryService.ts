import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { commentsService } from '@/lib/services/commentsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { plansService } from '@/lib/services/plansService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { foldersService } from '@/lib/services/foldersService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { inFlightCodeService } from '@/lib/services/inFlightCodeService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { aiDecisionBlockOf } from '@/lib/approvalGates/decisionRecord';
import {
  toPlanTreeFolders,
  toPlanTreeSkeleton,
  toSkeletonRows,
  toSearchResultRows,
  toBlockingEdges,
  toOrgContextResponse,
  toPendingPlanRows,
  toSimilarWorkItemRows,
} from '@/lib/mappers/aiBoundaryMappers';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { decodeSearchCursor, encodeSearchCursor } from '@/lib/mcp/searchCursor';
import type { FilterAst } from '@/lib/filters/ast';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  AI_PENDING_PLAN_STATUSES,
  AI_PENDING_PLANS_LIMIT,
  type PlanTreeResponse,
  type OrgContextResponse,
  type GetItemResponse,
  type SubtreeResponse,
  type BlockingClosureResponse,
  type PendingPlansResponse,
  type TerminalStatusesResponse,
  type SearchWorkItemsResponse,
  type SemanticSearchResponse,
  type SimilarWorkItemsResponse,
  type AiDecisionBlock,
} from '@/lib/dto/ai';
import { readProject } from '@/lib/workspaces/tenantRead';

// The ai→core boundary service (Subtask 7.1.6). The READ-back side of the
// boundary: the project's work-item skeleton (plan-tree) + the calling org's
// footprint (org-context), each orchestrated through the SAME permission-scoped
// services the UI/MCP use — never raw Prisma — so the AI reads only what the
// token's user could. Deliberately minimal: the rich graph-traversal retrieval is
// Story 7.5; this is the skeleton it grows from.
//
// The former WRITE side — `commitPlanDelta` / `POST /api/internal/ai/plan-delta`,
// the whole-delta buffered persist — was REMOVED by 7.4.4 (MOTIR-846). Generation
// no longer buffers a delta: it EMITS incremental `add` PlanItem proposals into a
// 7.21 `Plan` via `POST /api/internal/ai/plan-proposals` (aiGenerationService),
// and a real work-item tree appears only on APPROVE/materialize. There is no
// buffered atomic-persist path.

// The two per-row anchors every skeleton projection carries, read in ONE
// workspace context and each as ONE batched query: the latest revision id
// (MOTIR-1531 — the `baseRevision` a modify/remove anchors on) and the folder a
// filed item sits in (MOTIR-5410). Shared by every read in the skeleton family, so
// a row can never carry one anchor on one read and miss it on another.
// The third anchor is a DECISION's deciding gate (MOTIR-5958, MOTIR-10146): ONE batched
// read for the whole set, so the planner can date and order an epic's decisions
// without a `get-item` per child.
async function readRowAnchors(
  workItemIds: string[],
  ctx: ServiceContext,
): Promise<{
  revisionByItemId: Map<string, string>;
  folderIdByItemId: Map<string, string>;
  decisionByItemId: Map<string, AiDecisionBlock>;
}> {
  return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => ({
    revisionByItemId: await workItemRevisionRepository.findLatestIdsByWorkItemIds(workItemIds, tx),
    folderIdByItemId: await workItemRepository.findFolderIdsByWorkItemIds(workItemIds, tx),
    decisionByItemId: await readDecisionBlocks(workItemIds, tx),
  }));
}

/** Every decision's latest deciding gate in a set, keyed by work-item id — one query. */
async function readDecisionBlocks(
  workItemIds: string[],
  tx: Parameters<typeof approvalGateRepository.findDecisionGatesByWorkItemIds>[1],
): Promise<Map<string, AiDecisionBlock>> {
  const rows = await approvalGateRepository.findDecisionGatesByWorkItemIds(workItemIds, tx);
  return new Map(rows.map((row) => [row.workItemId, aiDecisionBlockOf(row)]));
}

export const aiBoundaryService = {
  // GET /api/internal/ai/plan-tree — the project's work-item skeleton. The
  // listWorkItems gate raises ProjectNotFoundError (404, never 403) for a
  // project the token's user can't browse — the cross-tenant posture (finding
  // #26). `projectKey` comes from the gated project row.
  async readPlanTree(projectId: string, ctx: ServiceContext): Promise<PlanTreeResponse> {
    const items = await workItemsService.listWorkItems(projectId, {}, ctx);
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    // ONE batched latest-revision lookup for the whole read (MOTIR-1531) — the
    // `baseRevision` anchor each row carries; never a per-row (N+1) fetch — and,
    // in the same context, ONE batched filed-placement lookup (MOTIR-5410).
    const { revisionByItemId, folderIdByItemId, decisionByItemId } = await readRowAnchors(
      items.map((i) => i.id),
      ctx,
    );
    // The project's folders ride BESIDE the rows, through the folder picker's own
    // browse-gated read and its own bound — so the tree read and the Move to…
    // picker can never disagree about which folders a project has.
    const folderList = await foldersService.listProjectFolders({ projectId }, ctx);
    return {
      project: { projectId, projectKey: project.identifier },
      items: toPlanTreeSkeleton(items, revisionByItemId, folderIdByItemId, decisionByItemId),
      folders: toPlanTreeFolders(folderList.folders),
      foldersTruncated: folderList.truncated,
    };
  },

  // GET /api/internal/ai/org-context (Subtask 7.3.45) — the calling org's
  // existing footprint, the read-back the discovery interview weighs when it
  // classifies a new project. The token scopes to a WORKSPACE; the org is that
  // workspace's parent. resolveWorkspaceAccess gates the workspace AS the token's
  // user AND yields its organizationId in one call (returns null when the user
  // can't reach the workspace → 404-not-403, the no-leak posture); the org
  // footprint is then summarised through organizationsService (also AS the user).
  async readOrgContext(ctx: ServiceContext): Promise<OrgContextResponse> {
    const access = await organizationsService.resolveWorkspaceAccess(ctx.userId, ctx.workspaceId);
    if (!access) {
      // The token's user can't reach this workspace — surface as not-found, never
      // leak that the org exists (OrganizationNotFoundError → 404, like plan-tree).
      throw new OrganizationNotFoundError(ctx.workspaceId);
    }
    const footprint = await organizationsService.summarizeOrgFootprint({
      userId: ctx.userId,
      organizationId: access.organizationId,
    });
    return toOrgContextResponse(footprint);
  },

  // GET /api/internal/ai/pending-plans (MOTIR-4106) — WHAT IS ALREADY PROPOSED
  // on the token's project: the plans a person still has to decide about.
  //
  // The one input GATE 1 names that had no read path. Every other internal read
  // in this family answers about the COMMITTED tree, and `plan-proposals`
  // answers about the CALLER'S OWN plan, resolved by `sourceJobId` — deliberately
  // so, since a job token must not read another job's plan. Neither can say "a
  // plan is already in flight here", which is the fact that turns a proposal into
  // a duplicate.
  //
  // ⚠️ THE STATUS SET IS THIS METHOD'S DECISION, NOT AN ARGUMENT
  // (`AI_PENDING_PLAN_STATUSES`). *Is this plan still in flight?* is one product
  // question; a parameter would let every consumer answer it differently, and the
  // consumer most likely to get it wrong is a prompt-assembling one that reads
  // `approved` as pending and warns about the tree.
  //
  // BOUNDED, and by the SAME `where` clause that narrows it: `listPlans` applies
  // both the status set and the limit in the repository, so the page returned is
  // a full page of pending plans rather than a filtered remnant of a mixed one.
  // `truncated` reports the cut — read off `nextCursor`, which is the service's
  // own answer to "was there more", and then DROPPED: this seam is a bounded
  // question, not a paginated list, so it never hands out a cursor.
  //
  // The project is the TOKEN's, gated by `plansService.listPlans`'s own
  // `assertCanBrowse` — the same gate the Plans page goes through.
  //
  // ⚠️ THE BROWSE DENIAL IS TRANSLATED HERE, NOT AT THE ROUTE, and this is
  // `readPlanTree`'s posture rather than a new one: that method re-throws
  // `ProjectNotFoundError` for a project outside the token's workspace, so the
  // boundary — not each route — is where "a project you cannot see does not
  // exist" is decided. `listPlans` is a UI read and raises the UI's
  // `ProjectAccessDeniedError('browse')`, which its own callers render as a 404;
  // letting that reach the route would put the no-leak decision in the transport,
  // one copy per endpoint. An 'edit' denial cannot arise on a read and is
  // rethrown untouched rather than folded into the 404.
  async readPendingPlans(projectId: string, ctx: ServiceContext): Promise<PendingPlansResponse> {
    let page;
    try {
      page = await plansService.listPlans(projectId, ctx, {
        status: AI_PENDING_PLAN_STATUSES,
        limit: AI_PENDING_PLANS_LIMIT,
      });
    } catch (err) {
      if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
        throw new ProjectNotFoundError(projectId);
      }
      throw err;
    }
    return {
      plans: toPendingPlanRows(page.plans),
      truncated: page.nextCursor !== null,
    };
  },

  // GET /api/internal/ai/terminal-statuses (MOTIR-4158) — the project's TERMINAL
  // status keys: every status whose category is `done`.
  //
  // ⚠️ THE POINT IS THE DERIVATION, NOT THE ANSWER. The consumer this exists for
  // was asking the question with a hardcoded `'done'`, which misses `cancelled`
  // — a status the DEFAULT workflow ships — and misses whatever else a customer
  // has configured as terminal. `workflowsService.getTerminalStatusKeys` derives
  // the set from `category = 'done'`, and it is the SAME call
  // `lib/plans/validateProposals.ts` step 4 makes to refuse a `modify` /
  // `remove` against finished work. Reading it from one service is what makes it
  // impossible for the persistence guard and a caller across the boundary to
  // hold two different notions of *terminal*.
  //
  // ⚠️ THE ACCESS GATE IS LOAD-BEARING AND CANNOT BE INFERRED FROM THE ANSWER.
  // `getTerminalStatusKeys` returns an EMPTY SET for a project outside the
  // workspace rather than throwing — a perfectly reasonable shape for a
  // predicate helper, and a leak-shaped 200 on a boundary. So the browse gate
  // runs FIRST and its refusal is the response: `assertCanBrowse` raises
  // `ProjectNotFoundError` for a cross-tenant project and for a token whose
  // `tokenProjectId` is not this one, and `ProjectAccessDeniedError('browse')`
  // for a project this user cannot see — both 404 at the route, so an empty
  // workflow and a project you may not read are never the same answer. This is
  // the gate `findSimilarWorkItems` uses, for the same reason it states.
  async readTerminalStatuses(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<TerminalStatusesResponse> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const keys = await workflowsService.getTerminalStatusKeys(projectId, ctx.workspaceId);
    // Sorted so the wire shape is a function of the workflow and not of row
    // order — two reads of an unchanged project are byte-identical.
    return { terminalStatusKeys: [...keys].sort() };
  },

  // ── Story 7.5 — the plan-tree GRAPH-TRAVERSAL read family ────────────────
  // The DEPTH reads a planner walks over the SAME job-scoped-token auth + tenant
  // gate as the skeleton. Each resolves its target by KEY within the token's
  // project (a cross-project / cross-tenant key → WorkItemNotFoundError → 404,
  // the no-leak posture) through the permission-scoped `workItemsService`, then
  // maps to the AI wire shape. `readPlanTree` above IS the `skeleton` tool.

  // GET /api/internal/ai/get-item — one work item by key, plus (on request) the
  // depth context 7.1.6 deferred: the cursor-paginated comment thread and the
  // cursor-paginated change log. `getWorkItemByIdentifier` is the gate (browse +
  // tenant, AS the token's user); comments/history are read only when asked.
  //
  // ⚠️ The item carries ALL FIVE relationship groups (MOTIR-4063). It used to
  // carry none: this read resolved through the LIGHT work-item shape while the
  // full set was assembled for the UI/MCP only, so a planner saw a TREE where
  // the product keeps a GRAPH. `blocked_by` reached it anyway — through
  // `walkBlocking`, its own read — and `blocks` was assumed reachable because
  // its PAIR was, though the closure has no inverse (MOTIR-4090). All five come
  // from ONE assembly now, so no member of the set can be classified by its
  // neighbour again.
  async getItem(
    projectId: string,
    key: string,
    ctx: ServiceContext,
    opts: {
      withComments?: boolean;
      withHistory?: boolean;
      commentsCursor?: string;
      historyCursor?: string;
    } = {},
  ): Promise<GetItemResponse> {
    // `key` may be the card's id as well as its key (MOTIR-8940): a plan names
    // committed cards by id, and a planner following that ref must land here in
    // one call rather than search by title.
    const item = await workItemsService.getWorkItemByRef(projectId, key, ctx);
    // ALL FIVE link groups (MOTIR-4063), from the assembly the item page already
    // uses — `getWorkItemByRef` is the gate, so this read follows it.
    // `restrictToProjectId` is not a new rule — it is the one this boundary
    // already applies to the only link kind that could cross it.
    // `getBlockingClosure` drops an out-of-project blocker outright
    // (`blockerProjectId !== root.projectId` → *"out-of-project → out of
    // scope"*), so `walk-blocking` has never named another project's row. The
    // token is scoped to ONE project and a relationship edge is a legitimate
    // CROSS-PROJECT link, so the four kinds arriving here take the same
    // treatment — otherwise widening the payload would open, on four new kinds,
    // exactly the path the closure was written to close.
    const links = await workItemsService.getRelationshipLinks(item.id, ctx, {
      restrictToProjectId: projectId,
    });
    // A decision's deciding gate (MOTIR-5958, MOTIR-10146), through the SAME one-query read
    // the skeleton rows use — so the item and its row can never disagree.
    const decisions = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      readDecisionBlocks([item.id], tx),
    );
    // Where the card's UNMERGED code lives, per repository (MOTIR-6618) — own open
    // delivery first, else the nearest ancestor's. Off the delivery rows only; no
    // provider call on this path. The MCP's `get_work_item` makes the same read
    // (`inFlightCodeService`, MOTIR-10069), so the two planners cannot disagree.
    const inFlight = await inFlightCodeService.readForItem(item.id, projectId, ctx);
    const response: GetItemResponse = {
      item: { ...item, ...links, decision: decisions.get(item.id) ?? null, ...inFlight },
    };
    if (opts.withComments) {
      response.comments = await commentsService.listComments(
        item.id,
        opts.commentsCursor ? { cursor: opts.commentsCursor } : {},
        ctx,
      );
    }
    if (opts.withHistory) {
      response.history = await workItemsService.listRevisionsPage(
        item.id,
        ctx,
        opts.historyCursor ? { cursor: opts.historyCursor } : {},
      );
    }
    return response;
  },

  // GET /api/internal/ai/get-subtree — a root (by key) + its descendants bounded
  // by `depth` (depth-bounded, never a whole-tree read). Each node is the same
  // skeleton row the planner folds into context; the response echoes the CLAMPED
  // depth the read applied.
  async getSubtree(
    projectId: string,
    rootKey: string,
    depth: number | undefined,
    ctx: ServiceContext,
  ): Promise<SubtreeResponse> {
    const root = await workItemsService.getWorkItemByIdentifier(projectId, rootKey, ctx);
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const { nodes, depth: effectiveDepth } = await workItemsService.getBoundedSubtree(
      root.id,
      ctx,
      depth,
    );
    const { revisionByItemId, folderIdByItemId, decisionByItemId } = await readRowAnchors(
      nodes.map((n) => n.id),
      ctx,
    );
    return {
      project: { projectId, projectKey: project.identifier },
      root: root.identifier,
      depth: effectiveDepth,
      nodes: toSkeletonRows(nodes, revisionByItemId, folderIdByItemId, decisionByItemId),
    };
  },

  // GET /api/internal/ai/walk-blocking — the transitive is_blocked_by closure of
  // a root (by key): "what must land before this". Cycle-safe + node/-depth
  // capped in the service; here we map node ids + edge endpoints to identifier
  // keys (the map spans the root + every closure node — every edge endpoint is
  // one of these).
  async walkBlocking(
    projectId: string,
    key: string,
    ctx: ServiceContext,
    opts: { maxDepth?: number; maxNodes?: number } = {},
  ): Promise<BlockingClosureResponse> {
    const root = await workItemsService.getWorkItemByIdentifier(projectId, key, ctx);
    const closure = await workItemsService.getBlockingClosure(root.id, ctx, opts);
    const idToKey = new Map<string, string>([[root.id, root.identifier]]);
    for (const n of closure.nodes) idToKey.set(n.id, n.identifier);
    const { revisionByItemId, folderIdByItemId, decisionByItemId } = await readRowAnchors(
      closure.nodes.map((n) => n.id),
      ctx,
    );
    return {
      root: root.identifier,
      nodes: toSkeletonRows(closure.nodes, revisionByItemId, folderIdByItemId, decisionByItemId),
      edges: toBlockingEdges(closure.edges, idToKey),
      truncated: closure.truncated,
    };
  },

  // POST /api/internal/ai/search-work-items (Subtask 7.5.2) — the on-demand
  // SEARCH tool for unbounded augment ("find the work items related to X"). It
  // rides the SHIPPED 6.1.1 FilterAST + the EXACT `/items` List read
  // (`getProjectIssuesList`) — no parallel query language, no raw Prisma — so
  // the planner and the page can never disagree on a result set, and the same
  // registry validation (unknown field/operator/bad value → FilterValidationError
  // → 422) and tenant gate (cross-tenant project → ProjectNotFoundError → 404)
  // apply unbypassed. The `ast` is already decoded by the route's shared 6.1.1
  // codec; an undefined `ast` pages the whole project.
  //
  // Pagination mirrors the `search_work_items` MCP tool (7.8.6): the opaque page
  // cursor wraps the List read's 1-based LIMIT/OFFSET page, so the surface is
  // paginated from day one (never a "return all"). A cursor that overshot the
  // tail reads as an empty terminal page (parity with the ready cursor), NOT a
  // re-fetch of the clamped last page that would loop. Returns the cheap
  // skeleton projection — the planner pulls DEPTH via `get_item` only for hits
  // it cares about.
  async searchWorkItems(
    projectId: string,
    opts: { ast?: FilterAst; cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<SearchWorkItemsResponse> {
    // The opaque cursor carries the next 1-based page; absent → page 1. A
    // malformed token throws InvalidSearchCursorError (→ 400 at the route).
    const requestedPage = opts.cursor ? decodeSearchCursor(opts.cursor).page : 1;

    const result = await workItemsService.getProjectIssuesList(
      projectId,
      {
        sort: DEFAULT_SORT,
        ...(opts.ast ? { filter: { ast: opts.ast } } : {}),
        page: requestedPage,
        ...(opts.limit !== undefined ? { pageSize: opts.limit } : {}),
      },
      ctx,
    );

    // The read CLAMPS an over-the-end page to the last page. A cursor that
    // overshot the tail must read as an empty terminal page, NOT a re-fetch of
    // the clamped last page (which would loop).
    const overshot = result.page < requestedPage;
    const items = overshot ? [] : result.items;
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const nextCursor =
      !overshot && result.page < totalPages ? encodeSearchCursor({ page: result.page + 1 }) : null;

    const revisionByItemId = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRevisionRepository.findLatestIdsByWorkItemIds(
        items.map((i) => i.id),
        tx,
      ),
    );
    return {
      items: toSearchResultRows(items, revisionByItemId),
      total: result.total,
      nextCursor,
    };
  },

  // POST /api/internal/ai/similar-work-items (Story MOTIR-2694 · Subtask
  // MOTIR-2697) — the SEMANTIC sibling of `searchWorkItems` above, and the whole
  // reason this story exists: `search-work-items` is a `contains` SUBSTRING
  // predicate, so a query for "persist UI preferences" cannot see a card titled
  // "Board columns remember their collapsed state", and GATE 1 reports "nothing
  // matches" — honestly, by its own evidence, and wrongly.
  //
  // The two are deliberately complementary, not rivals: this one PROPOSES
  // candidates by meaning, the keyed reads beside it DISPOSE of them against the
  // real record. It therefore returns `key` / `title` / `score` and nothing else
  // (ADR §2 — see `SimilarWorkItemRow`).
  //
  // THE PROJECT IS NEVER A PARAMETER. `projectId` is the JOB TOKEN's project,
  // resolved server-side by the route's `authenticateAndLimitJobRequest`, and
  // `assertCanBrowse` re-checks it against the acting user (`resolveInputs` is the
  // one place a project id meets an actor, MOTIR-2607) — so a planner cannot reach
  // another tenant's tree however it phrases the call, and a project it may not
  // browse is a 404, never a 403 (finding #26).
  //
  // ⚠️ DEGRADATION IS A 200, NEVER A 5xx (ADR §6.1). A planning job must not fail
  // because a candidate-finder had nothing to offer, so an unreadable embedding
  // store — no `vector` extension on a self-hosted build, a table that predates
  // the migration, a ranking query that errors — resolves to an EMPTY result with
  // `coverage: { embedded: 0, total: 0 }`, which the caller reads as "the store
  // could not be read" and distinguishes from `{ embedded: 0, total: 419 }` ("a
  // real project nothing has indexed yet"). Falling back to the relational
  // `contains` search is the CALLER's move (MOTIR-2691), because the caller is the
  // one that knows what it was looking for.
  //
  // The AUTHORIZATION gate deliberately sits OUTSIDE that catch: a caller who may
  // not browse the project must get its 404, never an empty 200 that reads as "I
  // looked and there was nothing here."
  async findSimilarWorkItems(
    projectId: string,
    opts: { queryEmbedding: number[]; model: string; limit: number; minScore?: number },
    ctx: ServiceContext,
  ): Promise<SimilarWorkItemsResponse> {
    await projectAccessService.assertCanBrowse(projectId, ctx);

    let ranked;
    try {
      ranked = await workItemEmbeddingsService.rankSimilar({
        workspaceId: ctx.workspaceId,
        projectId,
        model: opts.model,
        queryEmbedding: opts.queryEmbedding,
        limit: opts.limit,
      });
    } catch (err) {
      // LOGGED, not merely swallowed. A degraded read is indistinguishable from
      // an empty project at the wire if nothing records it, and "the embedding
      // store has been unreadable for a week" is exactly the condition that would
      // otherwise be discovered by someone wondering why the planner stopped
      // finding duplicates. `coverage: 0/0` is the caller's signal; this is the
      // operator's.
      console.error('[aiBoundaryService] semantic search degraded to an empty result', {
        projectId,
        model: opts.model,
        err,
      });
      return { results: [], model: opts.model, coverage: { embedded: 0, total: 0 } };
    }

    // The threshold is applied AFTER the top-N, never as a SQL predicate: the
    // ranking's under-return guarantee is stated in rows (`min(limit, rankable)`),
    // and a WHERE on the score would silently reopen the short-read the exact
    // fallback exists to close. No DEFAULT `minScore` is pinned — MOTIR-2698 owns
    // the question of whether one is warranted, and a threshold chosen without
    // data either suppresses real candidates or admits noise (ADR §6.1).
    const { minScore } = opts;
    const rows = toSimilarWorkItemRows(ranked.results);
    const results = minScore === undefined ? rows : rows.filter((r) => r.score >= minScore);

    return {
      results,
      model: opts.model,
      coverage: { embedded: ranked.rankable, total: ranked.total },
    };
  },

  /**
   * Semantic search from TEXT — what {@link findSimilarWorkItems} is once the
   * caller no longer has a vector (Story MOTIR-3098 · Subtask MOTIR-3101, per
   * `docs/decisions/plan-tree-embeddings.md` **Amendment 2**).
   *
   * §6.1's route takes a vector because its only caller, `motir-ai`, owns the
   * embedding seam. An MCP agent holds a Motir PAT and nothing else, so Amendment
   * 2 decides that `motir-core` embeds the query through the SAME
   * `POST /v1/embeddings` seam §6.2 already mandates for the write path. This
   * method is that composition and nothing more: embed, then rank through the
   * method above, which keeps the access gate, the degradation arm and the §2
   * `key`/`title`/`score` DTO in ONE place.
   *
   * ⚠️ THE ORDER OF THE FIRST TWO STEPS IS THE POINT. `assertCanBrowse` runs
   * BEFORE the embed, so a caller who may not browse the project never spends the
   * deployment's gateway budget — the same ordering `enforceInternalServiceRateLimit`
   * applies for the same reason. Its 404 also still beats an empty 200, which
   * would read as "I looked and there was nothing here."
   *
   * ⚠️ AND THE THREE NON-`ranked` STATES STAY APART. Collapsing them is the exact
   * defect the story exists to remove, so the discriminator is computed here —
   * once, server-side — rather than left to each caller's arithmetic over
   * `coverage`. See {@link SemanticSearchResponse}.
   */
  async searchSimilarWorkItemsByText(
    projectId: string,
    opts: { query: string; limit: number; minScore?: number },
    ctx: ServiceContext,
  ): Promise<SemanticSearchResponse> {
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const embedded = await workItemEmbeddingsService.embedQuery(opts.query);
    if (!embedded) {
      return {
        outcome: 'unavailable',
        results: [],
        model: null,
        coverage: null,
        message:
          'The query could not be embedded, so no semantic search ran — this deployment has no ' +
          'AI backend configured, or it is unreachable. This is NOT evidence that nothing ' +
          'similar exists. Fall back to `search_work_items`, remembering that it matches on ' +
          'SUBSTRINGS and cannot see a card that says the same thing in different words.',
      };
    }

    const ranked = await this.findSimilarWorkItems(
      projectId,
      {
        queryEmbedding: embedded.embedding,
        model: embedded.model,
        limit: opts.limit,
        ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
      },
      ctx,
    );

    if (ranked.results.length > 0) {
      return {
        outcome: 'ranked',
        results: ranked.results,
        model: ranked.model,
        coverage: ranked.coverage,
        message:
          `${ranked.results.length} candidate(s) ranked over ${ranked.coverage.embedded} of ` +
          `${ranked.coverage.total} indexed item(s). Read each one through \`get_work_item\` ` +
          'before concluding anything about it — this names candidates, it does not report them.',
      };
    }

    // Nothing ranked. WHICH nothing decides what the caller may conclude, and
    // `coverage.embedded` is the only thing that can tell them apart.
    if (ranked.coverage.embedded === 0) {
      return {
        outcome: 'not-indexed',
        results: [],
        model: ranked.model,
        coverage: ranked.coverage,
        message:
          `No item in this project is indexed for \`${ranked.model}\` (0 of ` +
          `${ranked.coverage.total}), so this search could not tell you anything. This is NOT ` +
          'evidence that nothing similar exists. Fall back to `search_work_items`, remembering ' +
          'that it matches on SUBSTRINGS.',
      };
    }

    return {
      outcome: 'nothing-similar',
      results: [],
      model: ranked.model,
      coverage: ranked.coverage,
      message:
        `Searched ${ranked.coverage.embedded} of ${ranked.coverage.total} indexed item(s) and ` +
        'nothing ranked. This IS an answer: the project is indexed and nothing close was found.',
    };
  },
};
