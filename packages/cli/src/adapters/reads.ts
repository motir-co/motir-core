import type { SuccessBody } from '../transport.js';
import type {
  ActivityAllPage,
  DispatchItem,
  DispatchRunAppended,
  DispatchRunOpened,
  DispatchRunView,
  RunGitCredentials,
  PlanJobState,
  PlanOutcome,
  PlanProposal,
  PlanSession,
  PlanTurn,
  PlanWithItems,
  SearchItemSummary,
  SearchPage,
  CompleteSessionResult,
  DispatchAdvisory,
  DispatchPrompt,
  ExpandSubmitResult,
  ActivityComment,
  ActivityCommentThread,
  ActivityEntry,
  ActivityHistoryPage,
  ActivityPart,
  ActivityValue,
  CommentsPage,
  ProjectList,
  ProjectRepository,
  ProjectRepositoryList,
  ProjectSummary,
  ReadyContainerPage,
  ReadyContainerSummary,
  ReadyItemSummary,
  ReadyPage,
  SprintList,
  SprintSummary,
  WhoamiResult,
  WorkItemChild,
  WorkItemDetail,
  WorkItemLink,
  WorkItemSummary,
  ScopeClaim,
  WorkItemClaim,
  WorkItemRepairClaim,
  WorkItemContinueClaim,
} from '../client.js';

// The READ ADAPTERS — wire shapes in, the CLI's own view models out
// (Story 11.5 · Subtask 11.5.4 — MOTIR-2212).
//
// ⚠️ THIS MODULE AND `src/transport.ts` ARE THE ONLY FILES THAT MAY SEE A
// GENERATED WIRE TYPE. That is `docs/decisions/cli-v1-client.md` Q4, and
// `tests/cli/generated-api-freshness.test.ts` enforces it over the real import
// graph rather than by review.
//
// ── Why an adapter layer exists at all ──────────────────────────────────────
// The two surfaces genuinely disagree about shape. MCP handed back a nested
// aggregate with a `parent`, an `ancestors` array of full summaries and three
// separate edge arrays; v1 hands back a flat item, a list of ancestor KEYS and
// one grouped `links` object. Both are reasonable. Neither can be swapped for
// the other in place, so something must translate — and the whole safety
// property of this story is that the something is ONE named module instead of a
// hundred small accommodations spread through `render.ts`.
//
// `render.ts` does not change. A diff on it fails this card. Every disagreement
// between the surfaces therefore has to surface HERE, where a test can see it.
//
// ── The rule these functions follow ─────────────────────────────────────────
// A view-model field with no reader is DROPPED, never fabricated from a value
// the wire did not send. This slice drops a project's `id` and `slug`, each
// verified by grep across `packages/cli/src` to have no consumer. Inventing a
// plausible-looking value would have been the easy path and would have put a lie
// one layer below every renderer.
//
// ── It grows one SLICE at a time ────────────────────────────────────────────
// It arrived with the IDENTITY mappers (11.5.4), gained the COLLECTION ones
// (11.5.21), and is completed by the detail + activity reshapes (11.5.22) —
// one module for the whole boundary, which was the point.

/**
 * The literal `?assigneeId=` takes to mean the UNASSIGNED bucket.
 *
 * Declared here because it is a WIRE value, and the boundary is this module's
 * job. The ready filter is TRI-STATE and all three states are reachable: the
 * parameter absent means any assignee, this literal means the unassigned
 * bucket, and a user id means that user. An empty value would be
 * indistinguishable from omitting it, which is why the bucket needs a name.
 */
export const UNASSIGNED = 'none';

/** `GET /api/v1/me`'s body. */
type MeBody = SuccessBody<'getMe'>;
/** `GET /api/v1/workspaces`'s body. */
type WorkspacesBody = SuccessBody<'listWorkspaces'>;
/** One page of `GET /api/v1/projects`. */
type ProjectsBody = SuccessBody<'listProjects'>;
/** One page of a ready ROW lane — `leaves` or `bugs` (Story MOTIR-6829). The two
 *  operations share one row schema (`ReadyLaneItem`), so one type serves both. */
type ReadyBody = SuccessBody<'getProjectReadyLeaves'>;
/** One page of the ready CONTAINERS lane. */
type ReadyContainersBody = SuccessBody<'getProjectReadyContainers'>;
/** One page of a project's sprints. */
type SprintsBody = SuccessBody<'listProjectSprints'>;
/** One page of a project's repository set. */
type RepositoriesBody = SuccessBody<'listProjectRepositories'>;
/** The work-item detail aggregate. */
type DetailBody = SuccessBody<'getWorkItem'>;
/** One page of the activity stream, in whichever view was asked for. */
type ActivityBody = SuccessBody<'getWorkItemActivity'>;

/** One row of a paged body, with the envelope's optional `items` resolved. */
type RowOf<B extends { items?: unknown[] }> = NonNullable<B['items']>[number];

/**
 * The rows a paged body carries.
 *
 * The generated envelope types `items` as optional because the page envelope and
 * the item schema compose through `allOf`; the server always sends it.
 */
function rowsOf<B extends { items?: unknown[] }>(body: B): RowOf<B>[] {
  return (body.items ?? []) as RowOf<B>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `whoami` — the token's user, plus the ONE workspace it is bound to.
 *
 * Two reads rather than one, because v1 splits them: `/me` names the workspace
 * by id and `/workspaces` describes it. The workspace is found BY THAT ID and
 * not assumed to be the first row — a user belongs to as many workspaces as they
 * belong to, and the token is bound to exactly one of them.
 *
 * `null` when the bound workspace is not in the list, which is the answer the
 * MCP tool gave too: a client that cannot see the workspace renders no
 * workspace, rather than a wrong one.
 */
export function toWhoami(me: MeBody, workspaces: WorkspacesBody): WhoamiResult {
  const bound = rowsOf(workspaces).find((workspace) => workspace.id === me.workspaceId);
  return {
    user: { id: me.user.id, name: me.user.name, email: me.user.email },
    workspace: bound ? { id: bound.id, name: bound.name, slug: bound.slug } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One project row.
 *
 * `id` and `slug` are DROPPED, not sourced: no file in `packages/cli/src` reads
 * either, and both are deliberately absent from the v1 project resource — `id`
 * by ADR §7, `slug` because nothing addresses a project by it. Carrying a
 * made-up value forward would freeze two dead fields into the CLI's contract.
 */
export function toProjectSummary(project: RowOf<ProjectsBody>): ProjectSummary {
  return { key: project.key, name: project.name, accessLevel: project.accessLevel };
}

/** A whole project list, assembled from every page the caller walked. */
export function toProjectList(pages: readonly ProjectsBody[]): ProjectList {
  const projects: ProjectSummary[] = [];
  for (const page of pages) projects.push(...rowsOf(page).map(toProjectSummary));
  return { projects };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ready set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One page of the ready set.
 *
 * The ORDER is the server's — the dispatch rank `(type asc, priority desc, key
 * asc)` — and passes through untouched. A client that re-sorted here would be
 * re-deriving the decision the ready endpoint exists to own.
 *
 * `assignee` is the minimal actor object MOTIR-2279 put on the row. The view
 * model's optional `dependencies` is always present from a v1 server: the wire
 * block is total, two arrays, empty rather than missing.
 */
export function toReadyPage(body: ReadyBody): ReadyPage {
  const items: ReadyItemSummary[] = rowsOf(body).map((row) => ({
    key: row.key,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    assignee: row.assignee === null ? null : { id: row.assignee.id, name: row.assignee.name },
    // The runnable container a lane row groups under (MOTIR-6835) — what
    // `motir ready` prints as a group header over its leaves.
    container: row.container === null ? null : toReadyContainerSummary(row.container),
    dependencies: {
      blockedBy: row.dependencies.blockedBy.map((edge) => ({ ...edge })),
      blocks: row.dependencies.blocks.map((edge) => ({ ...edge })),
    },
  }));
  // ⚠️ The cursor is OPAQUE and collection-scoped: echoed, never parsed, never
  // handed to another collection's read.
  return { items, nextCursor: body.nextCursor };
}

/** One runnable container, as a lane row names it or the containers lane lists it. */
export function toReadyContainerSummary(row: RowOf<ReadyContainersBody>): ReadyContainerSummary {
  return {
    key: row.key,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    assignee: row.assignee === null ? null : { id: row.assignee.id, name: row.assignee.name },
    readyLeafCount: row.readyLeafCount,
    childCount: row.childCount,
  };
}

/** A page of the CONTAINERS lane, in the server's group order. */
export function toReadyContainerPage(body: ReadyContainersBody): ReadyContainerPage {
  return { items: rowsOf(body).map(toReadyContainerSummary), nextCursor: body.nextCursor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprints
// ─────────────────────────────────────────────────────────────────────────────

/** One sprint row — a field-for-field carry; the two shapes agree. */
export function toSprintSummary(sprint: RowOf<SprintsBody>): SprintSummary {
  return {
    id: sprint.id,
    name: sprint.name,
    state: sprint.state,
    goal: sprint.goal,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    sequence: sprint.sequence,
    issueCount: sprint.issueCount,
    // Passed THROUGH, never defaulted: null means "never activated", and a
    // `?? 0` here would report a scope-lock baseline that was never taken.
    committedPoints: sprint.committedPoints,
    committedIssueCount: sprint.committedIssueCount,
  };
}

/** A whole sprint list, assembled from every page the caller walked. */
export function toSprintList(pages: readonly SprintsBody[]): SprintList {
  const sprints: SprintSummary[] = [];
  for (const page of pages) sprints.push(...rowsOf(page).map(toSprintSummary));
  return { sprints };
}

// ─────────────────────────────────────────────────────────────────────────────
// The project's repository SET (Story MOTIR-3584 · MOTIR-3586)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One repository row — a field-for-field carry; the two shapes agree.
 *
 * Every coordinate is nullable and is passed THROUGH rather than defaulted, and
 * that is the whole discipline here: `cloneUrl: null` is a real answer (either
 * the row names no repository yet, or its provider is one this build cannot
 * address), and a `?? ''` would turn "Motir does not know where this lives" into
 * a URL git will fail on. `established` is the discriminator a materializing
 * client branches on, published by the server so nobody re-derives it.
 */
export function toProjectRepository(repo: RowOf<RepositoriesBody>): ProjectRepository {
  return {
    id: repo.id,
    role: repo.role,
    label: repo.label,
    name: repo.name,
    repoRef: repo.repoRef,
    cloneUrl: repo.cloneUrl,
    defaultBranch: repo.defaultBranch,
    archived: repo.archived,
    state: repo.state,
    established: repo.established,
  };
}

/** The whole set, assembled from every page the caller walked — IN ORDER, which
 *  is load-bearing: the first row is the project's PRIMARY repository. */
export function toProjectRepositoryList(pages: readonly RepositoriesBody[]): ProjectRepositoryList {
  const repositories: ProjectRepository[] = [];
  for (const page of pages) repositories.push(...rowsOf(page).map(toProjectRepository));
  return { repositories };
}

// ─────────────────────────────────────────────────────────────────────────────
// The work-item detail aggregate — the sharpest reshape
// ─────────────────────────────────────────────────────────────────────────────

/** A v1 work-item REFERENCE as the CLI's summary shape. */
function toSummary(ref: {
  key: string;
  kind: string;
  title: string;
  status: string;
}): WorkItemSummary {
  return { identifier: ref.key, kind: ref.kind, title: ref.title, status: ref.status };
}

/**
 * The detail aggregate.
 *
 * Three reshapes, each recorded where it happens:
 *
 * • `ancestorKeys` → `ancestors`. The wire sends keys; `renderLineage` reads
 *   `.identifier` and nothing else, so the view model's element type narrowed to
 *   `{ identifier }` rather than this function inventing a kind/title/status.
 * • `links` (five groups of refs) → the three arrays the CLI declares. `linkId`
 *   is gone from the view model — nothing read it, and v1 does not publish it.
 * • `readiness.blockedByAncestorKey` + `…Title` → one `{ identifier, title }`.
 *   The two are null together on the wire, so the object is null or complete.
 */
export function toWorkItemDetail(body: DetailBody): WorkItemDetail {
  const children: WorkItemChild[] = body.children.map((child) => ({
    ...toSummary(child),
    dependencies: {
      blockedBy: child.dependencies.blockedBy.map((edge) => ({ ...edge })),
      blocks: child.dependencies.blocks.map((edge) => ({ ...edge })),
    },
  }));

  const link = (ref: Parameters<typeof toSummary>[0]): WorkItemLink => ({ item: toSummary(ref) });
  const ancestorKey = body.readiness.blockedByAncestorKey;

  return {
    item: {
      identifier: body.key,
      kind: body.kind,
      title: body.title,
      status: body.status,
      priority: body.priority,
      assigneeId: body.assigneeId,
      type: body.type,
      executor: body.executor,
      storyPoints: body.storyPoints,
      estimateMinutes: body.estimateMinutes,
      targetRepo: body.targetRepo,
      sprintId: body.sprintId,
      descriptionMd: body.descriptionMd,
    },
    // The item's OWN folder placement (MOTIR-5412): the name path, root first, or
    // `null` when the item is not filed. `?? null` because an older Motir sends no
    // such field, and "not filed" is the honest reading of silence for a line that
    // is simply not printed.
    folderPath: body.folderPath ?? null,
    // The DELIVERY SET (MOTIR-3697). Mapped field by field like everything else
    // here, and OMITTED rather than defaulted to `[]` when the server did not
    // send it: an older Motir saying nothing and a current one saying "no
    // deliveries" are different facts, and the watch loop treats only the first
    // as "I cannot tell".
    ...(body.deliveries
      ? {
          deliveries: body.deliveries.map((d) => ({
            repo: d.repo,
            number: d.number,
            title: d.title,
            url: d.url,
            state: d.state,
            ci: d.ci,
            baseRef: d.baseRef,
            defaultBranch: d.defaultBranch,
            // MOTIR-5720. `?? null` because an older Motir sends no such field, and
            // "no standing queue failure" is the honest reading of that silence.
            queueExit: d.queueExit
              ? {
                  rawReason: d.queueExit.rawReason,
                  headSha: d.queueExit.headSha,
                  failingCheckName: d.queueExit.failingCheckName,
                  failingCheckUrl: d.queueExit.failingCheckUrl,
                }
              : null,
          })),
        }
      : {}),
    ancestors: body.ancestorKeys.map((key) => ({ identifier: key })),
    children,
    blockedBy: body.links.blockedBy.map(link),
    blocks: body.links.blocks.map(link),
    relatesTo: body.links.relatesTo.map(link),
    readiness: {
      ready: body.readiness.ready,
      openBlockers: body.readiness.openBlockers.map(toSummary),
      blockedByAncestor:
        ancestorKey === null
          ? null
          : { identifier: ancestorKey, title: body.readiness.blockedByAncestorTitle ?? '' },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The activity stream
// ─────────────────────────────────────────────────────────────────────────────

/** One wire activity entry, whichever arm of the union it is. */
type WireEntry = RowOf<ActivityBody>;
/** The `comment` arm's payload. */
type WireCommentThread = Extract<WireEntry, { type: 'comment' }>['comment'];
/** The `change` arm's payload. */
type WireChange = Extract<WireEntry, { type: 'change' }>['change'];
/** One wire activity VALUE. */
type WireValue = Extract<WireChange['parts'][number], { kind: 'field' }>['from'];

/**
 * One resolved value inside a history entry.
 *
 * The CLI's `ActivityValue` is deliberately LOOSER than the wire's closed union
 * — `type` a `string` with optional members — because the CLI is published to
 * npm on its own release train and routinely meets a server NEWER than itself.
 * `activityValueText`'s default branch has to stay REACHABLE; a faithful
 * re-narrowing here would make it unreachable-by-type and turn an unfamiliar
 * value into a crash instead of a generic rendering.
 *
 * The one RENAME: the wire's `workItemKey` becomes `identifier`, which is what
 * `render.ts:850` reads.
 */
function toActivityValue(value: WireValue): ActivityValue {
  switch (value.type) {
    case 'text':
      return { type: 'text', text: value.text };
    case 'status':
      return { type: 'status', key: value.key, label: value.label };
    case 'user':
      return { type: 'user', userId: value.userId, name: value.name };
    case 'date':
      return { type: 'date', date: value.date };
    case 'sprint':
      return { type: 'sprint', sprintId: value.sprintId, name: value.name };
    case 'issue':
      return { type: 'issue', identifier: value.workItemKey };
    default:
      return { type: value.type };
  }
}

/** One renderable piece of a history entry. */
function toActivityPart(part: WireChange['parts'][number]): ActivityPart {
  switch (part.kind) {
    case 'field':
      return {
        kind: 'field',
        field: part.field,
        from: toActivityValue(part.from),
        to: toActivityValue(part.to),
      };
    case 'fieldEdited':
      return { kind: 'fieldEdited', field: part.field };
    case 'link':
      return {
        kind: 'link',
        op: part.op,
        linkKind: part.linkKind,
        target: toActivityValue(part.target),
      };
    case 'collection':
      return { kind: 'collection', field: part.field, op: part.op, items: [...part.items] };
    case 'commentDeleted':
      return {
        kind: 'commentDeleted',
        author: toActivityValue(part.author),
        replyCount: part.replyCount,
      };
    case 'generic':
      return { kind: 'generic', key: part.key, from: part.from, to: part.to };
    default:
      // `created` / `archived` / `unarchived` carry nothing but their kind, and
      // so does any kind a newer server invents.
      return { kind: part.kind };
  }
}

/** One CHANGE-trail entry. */
function toActivityEntry(change: WireChange): ActivityEntry {
  return {
    id: change.id,
    changeKind: change.changeKind,
    changedAt: change.changedAt,
    actor: { userId: change.actor.userId, name: change.actor.name },
    parts: change.parts.map(toActivityPart),
  };
}

/** One comment, without its replies. */
function toComment(comment: Omit<WireCommentThread, 'replies'>): ActivityComment {
  return {
    id: comment.id,
    author: { id: comment.author.id, name: comment.author.name },
    bodyMd: comment.bodyMd,
    editedAt: comment.editedAt,
    createdAt: comment.createdAt,
  };
}

/** A root comment with its single-level replies. */
function toCommentThread(thread: WireCommentThread): ActivityCommentThread {
  return { ...toComment(thread), replies: thread.replies.map(toComment) };
}

/**
 * The merged `all` page.
 *
 * `totalComments` / `totalChanges` are what MOTIR-2320 put on the wire, and they
 * are why that card exists: `renderActivityStream`'s footer derives "44 more
 * comments, 16 more changes" as `total − shown`, which the page's own item
 * counts cannot supply. They are nullable on the wire because the NARROW views
 * do not count both sources; on THIS view the server always sends both.
 */
export function toActivityAllPage(body: ActivityBody): ActivityAllPage {
  return {
    entries: rowsOf(body).map((entry) =>
      entry.type === 'comment'
        ? ({ type: 'comment', thread: toCommentThread(entry.comment) } as const)
        : ({ type: 'history', entry: toActivityEntry(entry.change) } as const),
    ),
    nextCursor: body.nextCursor,
    totalComments: body.totalComments ?? 0,
    totalChanges: body.totalChanges ?? 0,
  };
}

/**
 * The `comments` page.
 *
 * `order` is not on the wire and does not need to be: it is what the CLI ITSELF
 * asked for, so echoing the requested value (or this view's shipped default,
 * `asc`) reports the direction the page was actually read in without inventing a
 * fact the server never stated.
 */
export function toCommentsPage(body: ActivityBody, order: 'asc' | 'desc'): CommentsPage {
  const threads = rowsOf(body)
    .filter((entry): entry is Extract<WireEntry, { type: 'comment' }> => entry.type === 'comment')
    .map((entry) => toCommentThread(entry.comment));
  return { threads, nextCursor: body.nextCursor, totalCount: body.totalCount, order };
}

/** The `history` page. */
export function toActivityHistoryPage(body: ActivityBody): ActivityHistoryPage {
  const entries = rowsOf(body)
    .filter((entry): entry is Extract<WireEntry, { type: 'change' }> => entry.type === 'change')
    .map((entry) => toActivityEntry(entry.change));
  return { entries, nextCursor: body.nextCursor, totalCount: body.totalCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// The dispatch + session operations (Subtask 11.5.5 — MOTIR-2213)
// ─────────────────────────────────────────────────────────────────────────────

/** The assembled dispatch prompt. */
type PromptBody = SuccessBody<'getWorkItemDispatchPrompt'>;
/** The bulk session close-out. */
type CloseOutBody = SuccessBody<'completeSession'>;
/** The planner job handle an expansion submit returns. */
type JobHandleBody = SuccessBody<'submitWorkItemExpansion'>;

/**
 * The dispatch prompt.
 *
 * ⚠️ `targetRepoCloneUrl` / `targetRepoDefaultBranch` are CARRIED AGAIN
 * (MOTIR-3588). They were dropped under the field-with-no-reader rule, and that
 * was correct while `resolveDispatchTarget` routed on `targetRepo` alone. The
 * reader now exists: a dispatch whose target checkout is missing materializes it
 * from that URL instead of launching the agent at the workspace root against a
 * git workflow that cannot run outside a repository. The rule is unchanged — a
 * field with no reader is still dropped; this one acquired one.
 *
 * ⚠️ `advisories` is re-shaped by PASSING THROUGH, deliberately. The wire's
 * union is open — `severity` is a bare string, and ADR §8 documents it as
 * open-ended — so a build that has never heard of a severity must hand the
 * object to `renderDispatchAdvisories` intact and let its fall-through print
 * nothing. Narrowing here would turn a forward-compatible client into one that
 * drops, or crashes on, the next advisory type someone adds.
 */
export function toDispatchPrompt(body: PromptBody): DispatchPrompt {
  return {
    key: body.key,
    prompt: body.prompt,
    parentKey: body.parentKey,
    targetRepo: body.targetRepo,
    // Absent from an older server stays ABSENT rather than becoming an explicit
    // `null`: `exactOptionalPropertyTypes` makes those different types, and the
    // resolution reads "no clone URL" from both, so nothing is lost by keeping
    // the distinction honest.
    ...(body.targetRepoCloneUrl === undefined
      ? {}
      : { targetRepoCloneUrl: body.targetRepoCloneUrl }),
    ...(body.targetRepoDefaultBranch === undefined
      ? {}
      : { targetRepoDefaultBranch: body.targetRepoDefaultBranch }),
    // MOTIR-3133 — the SET, carried because the launcher resolves a checkout per
    // element; and MOTIR-3136 — `delivery` with it, because the run REPORTS what
    // has already shipped, which is the only thing that distinguishes a resume
    // from a fresh card. (MOTIR-3133 dropped `delivery` under the field-with-no-
    // reader rule; this card is the reader, so it is carried.) Absent from an
    // older server stays absent, so the single-repository path is what runs.
    ...(body.targetRepos === undefined
      ? {}
      : {
          targetRepos: body.targetRepos.map((repo) => ({
            name: repo.name,
            cloneUrl: repo.cloneUrl,
            defaultBranch: repo.defaultBranch,
            delivery: repo.delivery,
          })),
        }),
    workflowMode: body.workflowMode,
    sessionBranch: body.sessionBranch,
    // MOTIR-6539 — carried because the run NAMES it on `checkout_ready` and
    // checkpoints it while the agent works. Absent from an older server stays
    // absent, and absent means "nothing to checkpoint".
    ...(body.workBranch === undefined ? {} : { workBranch: body.workBranch }),
    // MOTIR-6530 — absent from an older server stays absent.
    ...(body.branch === undefined ? {} : { branch: body.branch }),
    advisories: body.advisories as DispatchAdvisory[],
  };
}

/**
 * The bulk close-out result.
 *
 * The per-item outcomes are reported VERBATIM — the client never re-derives one.
 * A partial close (some items done, others refused with a reason) is a real
 * answer the server computed transactionally, not a failure to smooth over.
 */
export function toCompleteSessionResult(body: CloseOutBody): CompleteSessionResult {
  return {
    sessionBranch: body.sessionBranch,
    results: body.results.map((result) => ({
      key: result.key,
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })),
  };
}

/**
 * The planner job handle.
 *
 * `statusUrl` is dropped for the reason the prompt's two extra fields are: no
 * reader. The CLI submits and returns; `motir auto --include-planning` never
 * polls, because what comes back is a plan a human must approve.
 */
export function toExpandSubmitResult(body: JobHandleBody): ExpandSubmitResult {
  return { jobId: body.jobId, planId: body.planId };
}

/** The keyed CLAIM result (MOTIR-2961). The wire shape and the view model agree
 *  field for field, so this adapter re-states rather than translates — and it
 *  exists anyway, because `client.ts` may not see a generated wire type (Q4). */
export function toWorkItemClaim(body: SuccessBody<'claimWorkItem'>): WorkItemClaim {
  return {
    key: body.key,
    title: body.title,
    outcome: body.outcome,
    claimed: body.claimed,
    status: { key: body.status.key, category: body.status.category },
    assignee: body.assignee ? { id: body.assignee.id, name: body.assignee.name } : null,
    transitionedBy: body.transitionedBy
      ? { id: body.transitionedBy.id, name: body.transitionedBy.name }
      : null,
    transitionedAt: body.transitionedAt,
  };
}

/**
 * The REPAIR claim result (MOTIR-5464) — restated field by field, and each pull
 * request element by element, for the reason {@link toWorkItemClaim} gives.
 */
/** The CONTINUE claim (MOTIR-6532), field by field. */
export function toWorkItemContinueClaim(
  body: SuccessBody<'claimWorkItemContinue'>,
): WorkItemContinueClaim {
  const ref = (a: { id: string; name: string } | null) => (a ? { id: a.id, name: a.name } : null);
  const pr = (p: SuccessBody<'claimWorkItemContinue'>['pullRequest']) =>
    p ? { repo: p.repo, number: p.number, url: p.url, headRef: p.headRef } : null;
  return {
    key: body.key,
    title: body.title,
    outcome: body.outcome,
    reason: body.reason,
    parentKey: body.parentKey,
    runId: body.runId,
    holder: ref(body.holder),
    startedAt: body.startedAt,
    deadRun: body.deadRun
      ? {
          id: body.deadRun.id,
          command: body.deadRun.command,
          origin: body.deadRun.origin,
          status: body.deadRun.status,
          stopReason: body.deadRun.stopReason,
          lastHeardAt: body.deadRun.lastHeardAt,
          dispatcher: ref(body.deadRun.dispatcher),
        }
      : null,
    branch: body.branch,
    branches: body.branches.map((b) => ({
      repository: b.repository,
      branch: b.branch,
      pullRequest: pr(b.pullRequest),
    })),
    pullRequest: pr(body.pullRequest),
    previousAssignee: ref(body.previousAssignee),
    mode: body.mode,
    landedKeys: [...body.landedKeys],
    resumedKeys: [...body.resumedKeys],
    // The gates of a run that stopped at one (MOTIR-7708) — what the takeover line
    // names when it resumes after an approval, and what a gate refusal names.
    gates: body.gates.map((g) => ({ key: g.key, kind: g.kind, state: g.state })),
    resumesGated: body.resumesGated,
  };
}

export function toWorkItemRepairClaim(
  body: SuccessBody<'claimWorkItemRepair'>,
): WorkItemRepairClaim {
  return {
    key: body.key,
    title: body.title,
    outcome: body.outcome,
    reason: body.reason,
    runTargetKey: body.runTargetKey,
    runId: body.runId,
    holder: body.holder ? { id: body.holder.id, name: body.holder.name } : null,
    startedAt: body.startedAt,
    // A server older than contract 1.43.0 sends neither field; every repair it can
    // hand over is a CI one.
    repairClass: body.repairClass ?? 'ci',
    acceptanceRefusal: body.acceptanceRefusal
      ? {
          reasonMd: body.acceptanceRefusal.reasonMd,
          decidedByLabel: body.acceptanceRefusal.decidedByLabel,
          decidedAt: body.acceptanceRefusal.decidedAt,
        }
      : null,
    // A server older than contract 1.58.0 sends no `reviewRefusal` (MOTIR-6822).
    reviewRefusal: body.reviewRefusal
      ? {
          gate: body.reviewRefusal.gate,
          findingsMd: body.reviewRefusal.findingsMd,
          reviewerName: body.reviewRefusal.reviewerName,
          decidedAt: body.reviewRefusal.decidedAt,
        }
      : null,
    pullRequests: body.pullRequests.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      ci: pr.ci,
      failingChecks: [...pr.failingChecks],
      queueExit: pr.queueExit
        ? {
            rawReason: pr.queueExit.rawReason,
            exitedAt: pr.queueExit.exitedAt,
            headSha: pr.queueExit.headSha,
            failingCheckName: pr.queueExit.failingCheckName,
            failingCheckUrl: pr.queueExit.failingCheckUrl,
          }
        : null,
      // Bug MOTIR-12095 (contract 1.91.0): why a GREEN member was handed over.
      conflicted: pr.conflicted,
      outOfDate: pr.outOfDate,
    })),
  };
}

/**
 * The SCOPE claim result (MOTIR-3049 · MOTIR-3198) — the scope-shaped sibling
 * of {@link toWorkItemClaim}.
 *
 * Same shape of job: the wire and the view model agree field for field, and the
 * adapter exists anyway because `client.ts` may not see a generated wire type
 * (ADR Amendment 12 Q4). Every array is re-stated element by element rather than
 * passed through, so a field the server adds later cannot arrive in the view
 * model without somebody deciding it should.
 */
/**
 * The DISPATCH RUN a report opened (Story MOTIR-1789 · MOTIR-1794).
 *
 * The reporter needs exactly three things off the open — the run's id, whether
 * this call CREATED it, and the legs it now owns keyed by card — and reads
 * nothing else. A wider adapter would make the reporter's behaviour depend on
 * fields the ingest is free to change.
 */
export function toDispatchRunOpened(body: SuccessBody<'openDispatchRun'>): DispatchRunOpened {
  return {
    runId: body.run.id,
    created: body.created,
    status: body.run.status,
    seq: body.run.seq,
    cards: body.run.cards.map((card) => ({ key: card.key, disposition: card.disposition })),
  };
}

/** A run READ back, for a CLI adopting a run the server opened (MOTIR-6558). */
export function toDispatchRunView(body: SuccessBody<'getDispatchRun'>): DispatchRunView {
  return {
    runId: body.id,
    status: body.status,
    command: body.command,
    origin: body.origin,
    model: body.model,
    endedAt: body.endedAt,
    cards: [...body.cards]
      .sort((a, b) => a.position - b.position)
      .map((card) => ({ key: card.key, position: card.position, disposition: card.disposition })),
    continues: body.continues
      ? {
          fromRunId: body.continues.fromRunId,
          branch: body.continues.branch,
          branches: body.continues.branches.map((b) => ({
            repository: b.repository,
            branch: b.branch,
            cloneUrl: b.cloneUrl ?? null,
          })),
          mode: body.continues.mode,
          landedKeys: [...body.continues.landedKeys],
          resumedKeys: [...body.continues.resumedKeys],
        }
      : null,
    // A server older than contract 1.59.0 sends no `repair` (MOTIR-6929).
    repair: body.repair
      ? {
          repairClass: body.repair.repairClass,
          title: body.repair.title,
          pullRequests: body.repair.pullRequests.map((pr) => ({
            repo: pr.repo,
            number: pr.number,
            url: pr.url,
            branch: pr.branch,
            baseRef: pr.baseRef,
            headSha: pr.headSha,
          })),
          resume: body.repair.resume ? { ...body.repair.resume } : null,
          findings: body.repair.findings ? { ...body.repair.findings } : null,
        }
      : null,
    // A server older than contract 1.89.0 sends no `review` (MOTIR-11953).
    review: body.review
      ? { gateId: body.review.gateId, subjectVersion: body.review.subjectVersion }
      : null,
  };
}

/** A hosted run's git credentials, one per repository (MOTIR-6538). */
export function toRunGitCredentials(
  body: SuccessBody<'issueDispatchRunGitCredentials'>,
): RunGitCredentials {
  return {
    credentials: body.credentials.map((c) => ({
      repository: c.repository,
      token: c.token,
      expiresAt: c.expiresAt,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
    })),
    dispatchedBy: body.dispatchedBy,
  };
}

/** What an APPEND returned — the new cursor, and how many rows were new. */
export function toDispatchRunAppended(
  body: SuccessBody<'appendDispatchRunEvents'>,
): DispatchRunAppended {
  return { runId: body.runId, appended: body.appended, seq: body.seq };
}

export function toScopeClaim(body: SuccessBody<'claimScope'>): ScopeClaim {
  return {
    scope: {
      kind: body.scope.kind,
      key: body.scope.key,
      sprintId: body.scope.sprintId,
      name: body.scope.name,
    },
    outcome: body.outcome,
    claimed: body.claimed,
    members: body.members.map((m) => ({
      key: m.key,
      title: m.title,
      status: { key: m.status.key, category: m.status.category },
    })),
    offender: body.offender
      ? {
          key: body.offender.key,
          title: body.offender.title,
          status: { key: body.offender.status.key, category: body.offender.status.category },
          assignee: body.offender.assignee
            ? { id: body.offender.assignee.id, name: body.offender.assignee.name }
            : null,
          transitionedBy: body.offender.transitionedBy
            ? { id: body.offender.transitionedBy.id, name: body.offender.transitionedBy.name }
            : null,
          transitionedAt: body.offender.transitionedAt,
        }
      : null,
    shape: body.shape
      ? { child: body.shape.child, childTitle: body.shape.childTitle, depth: body.shape.depth }
      : null,
    blockers: body.blockers.map((b) => ({
      item: b.item,
      blockedBy: b.blockedBy,
      blockerStatus: b.blockerStatus,
      blockerSprintId: b.blockerSprintId,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The work-item COLLECTION and its COUNT (Subtask 11.5.17 — MOTIR-2319)
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the work-item collection. */
type WorkItemRow = SuccessBody<'listProjectWorkItems'>['items'][number];
/** The count body. */
type CountBody = SuccessBody<'countProjectWorkItems'>;

/**
 * One search result row.
 *
 * ⚠️ `key` becomes `identifier`. The wire names every work item by its key
 * (ADR §7) and the view model has said `identifier` since long before this
 * port; renaming the view-model field would reach into `render.ts`, which this
 * card may not touch. So the rename lives HERE, which is the adapter boundary
 * doing exactly what it exists for — the wire's vocabulary stops at this line.
 *
 * `dependencies` is always present on a v1 row, so it is always set. The view
 * model keeps it OPTIONAL because a CLI meets older servers, and a renderer
 * that degrades on absence must stay reachable.
 */
function toSearchItem(row: WorkItemRow): SearchItemSummary {
  return {
    identifier: row.key,
    kind: row.kind,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dependencies: {
      blockedBy: row.dependencies.blockedBy.map((edge) => ({ ...edge })),
      blocks: row.dependencies.blocks.map((edge) => ({ ...edge })),
    },
  };
}

/** One page of the work-item collection. */
export function toSearchPage(body: SuccessBody<'listProjectWorkItems'>): SearchPage {
  return { items: body.items.map(toSearchItem), nextCursor: body.nextCursor };
}

/**
 * How many work items match — the whole body, unwrapped to the number.
 *
 * The envelope exists because ADR Amendment 14 says a count is its own
 * operation with its own response object; the CLI has no use for the wrapper,
 * and a caller asking "how many" should get a number.
 */
export function toWorkItemCount(body: CountBody): number {
  return body.count;
}

// ─────────────────────────────────────────────────────────────────────────────
// The PLANNING CONVERSATION (Subtask 11.5.20 — MOTIR-2341)
// ─────────────────────────────────────────────────────────────────────────────

/** The conversation, thread included. */
type PlanSessionBody = SuccessBody<'openPlanSession'>;
/** What became of a submitted planning job. */
type PlanOutcomeBody = SuccessBody<'getPlanStatus'>;
/** A plan with its proposals. */
type PlanBody = SuccessBody<'getPlan'>;

/**
 * One turn of the thread.
 *
 * `question` and `isAnswer` are carried since MOTIR-2397, and only because they
 * are READ: `question` is what `pendingQuestion` scans for to decide the thread
 * is waiting on the user, and `isAnswer` is what tells an answer apart from a
 * turn that superseded the question. Every field on the view model has a
 * renderer — a field that arrives with none is a claim the CLI does not keep.
 * `jobId` stays because the system marker turn prints the job it submitted.
 */
function toPlanTurn(turn: PlanSessionBody['turns'][number]): PlanTurn {
  return {
    id: turn.id,
    seq: turn.seq,
    role: turn.role,
    body: turn.body,
    jobId: turn.jobId,
    question: turn.question,
    isAnswer: turn.isAnswer,
    authorId: turn.authorId,
    createdAt: turn.createdAt,
  };
}

/**
 * The planning conversation.
 *
 * `projectId` leaves the view model: the wire does not publish it (a project is
 * named by its KEY on this API, ADR §7), nothing rendered it, and the CLI
 * already knows which project it opened the conversation for.
 */
export function toPlanSession(body: PlanSessionBody): PlanSession {
  return {
    id: body.id,
    targetKeys: body.targetKeys,
    turnCount: body.turnCount,
    lastJobId: body.lastJobId,
    lastSubmittedAt: body.lastSubmittedAt,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    turns: body.turns.map(toPlanTurn),
  };
}

/**
 * What became of a submitted planning job.
 *
 * ⚠️ `job` is populated ONLY while the plan is `generating`, and reading it is
 * what makes a bounded watch possible: a failed motir-ai job leaves its plan at
 * `generating` forever — there is no synthetic failed plan state — so a
 * status-only loop would poll a corpse until it timed out. The block is carried
 * across verbatim, `failure` included, because the command surfaces the
 * server's own code and message rather than a paraphrase nobody can search for.
 */
export function toPlanOutcome(body: PlanOutcomeBody): PlanOutcome {
  return {
    planId: body.planId,
    status: body.status,
    origin: body.origin,
    jobId: body.jobId,
    itemCount: body.proposalCount,
    job:
      body.job === null
        ? null
        : {
            // The job status vocabulary is the QUEUE's, not this API's, so the
            // wire types it as an open string. The view model's union is what
            // the CLI knows how to reason about; a status outside it reads as
            // "running" to `watchVerdict`, which is the safe default — keep
            // waiting rather than declare a live job dead.
            status: body.job.status as PlanJobState['status'],
            reachable: body.job.reachable,
            failure: body.job.failure === null ? null : { ...body.job.failure },
          },
  };
}

/**
 * ONE proposal — never a work item.
 *
 * `workItemId` becomes `workItemKey`, and that is a rename with teeth: the wire
 * publishes the `MOTIR-<n>` KEY (ADR §7 — an internal id is not addressable on
 * this API at all), so `motir plan` now prints a target a person can act on
 * instead of a cuid. `null` still means "no target", which on an `add` is the
 * contract: it is how a client tells a proposal from a work item.
 */
function toPlanProposal(proposal: PlanBody['proposals'][number]): PlanProposal {
  const fields = proposal.proposedFields;
  return {
    id: proposal.id,
    op: proposal.op,
    workItemKey: proposal.workItemKey,
    proposedFields:
      fields === null
        ? null
        : {
            title: fields.title,
            ...(fields.kind === null ? {} : { kind: fields.kind }),
            type: fields.type,
            priority: fields.priority,
            executor: fields.executor,
            storyPoints: fields.storyPoints,
            estimateMinutes: fields.estimateMinutes,
            descriptionMd: fields.descriptionMd,
          },
    patch: proposal.patch,
    parentRef: proposal.parentRef,
    blockedByRefs: proposal.blockedByRefs,
  };
}

/** A plan with the proposals it bundles. */
export function toPlanWithItems(body: PlanBody): PlanWithItems {
  return {
    id: body.id,
    status: body.status,
    title: body.title,
    summary: body.summary,
    sourceJobId: body.sourceJobId,
    origin: body.origin,
    itemCount: body.proposalCount,
    items: body.proposals.map(toPlanProposal),
  };
}

/**
 * One ready row as the DISPATCH loop reads it (Subtask 11.5.23 — MOTIR-2398).
 *
 * The narrowest of the views over this row — `toReadyPage` renders a table,
 * this one routes a run — and what it drops is the point:
 *
 * • `descriptionExcerpt` — display, and nothing here displays. The assignee's
 *   NAME is kept (MOTIR-7477): a run report names who a skipped manual card
 *   waits on.
 * • `dependencies` — a ready item's blockers are satisfied by definition, so
 *   the edge block has nothing to tell a loop about to dispatch it.
 * • `targetRepo` is not dropped, it was never here. The row omits it
 *   deliberately (Amendment 10 Q2); the loop reads it from the dispatch prompt,
 *   which it calls anyway before it can hand an agent anything.
 */
export function toDispatchItem(row: ReadyBody['items'][number]): DispatchItem {
  return {
    key: row.key,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    status: { key: row.status.key, category: row.status.category },
    type: row.type,
    executor: row.executor,
    assigneeId: row.assigneeId,
    assigneeName: row.assignee?.name ?? null,
    inheritedSessionBranch: row.inheritedSessionBranch,
    containerKey: row.container?.key ?? null,
  };
}
