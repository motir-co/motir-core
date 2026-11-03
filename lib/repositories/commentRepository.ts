import { Prisma, type Comment } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Comment repository — single Prisma operations on the `comment` table
// (Story 5.1 · Subtask 5.1.1). The persistence leaf under commentsService
// (5.1.2), which owns the transactions, the permission matrix, the
// single-level-threading validation (depth >1 rejected THERE — the schema
// only carries the self-FK), mention parsing, and DTO mapping.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx` (a comment write always rides
// a transaction — its mention rows and, on delete, the work_item_revision
// deletion record must commit atomically with it). Pure read paths use the
// `db` singleton (optional `tx` for reads inside a transaction). No business
// logic, no transactions, no DTO mapping here.
//
// No error translation: the table has no triggers; a cross-workspace write
// attempt is caught by the RLS policy's WITH CHECK (42501) for non-bypass
// roles, and the service's own view-gate is the application-layer guard.

/**
 * A root comment with its (single-level) thread riding along — the shape
 * `listThreadsByWorkItem` returns. Replies are bounded by the one-level
 * threading decision, so a thread always loads whole (Story 5.1).
 */
export type CommentWithReplies = Prisma.CommentGetPayload<{ include: { replies: true } }>;

/**
 * The bound on the public-request comment thread read (Subtask 6.12.12 — the
 * at-scale rule: a public detail never loads every comment). The detail shows
 * the most recent N public comments oldest-first; a longer thread drops its
 * oldest rows (a "load older" page is a later hardening, like the roadmap's
 * per-column paging — flagged in the 6.12.12 PR).
 */
export const PUBLIC_REQUEST_COMMENT_CAP = 100;

export const commentRepository = {
  /**
   * Insert one comment. Required `tx` — the mention rows the service parses
   * out of the body persist in the SAME transaction (5.1.2). Unchecked input:
   * the service already holds the scalar FKs (workspaceId / workItemId /
   * authorId / parentCommentId).
   */
  async create(
    data: Prisma.CommentUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Comment> {
    return tx.comment.create({ data });
  },

  /**
   * Patch one comment (the body edit — the service sets `editedAt` alongside
   * `bodyMd`, driving the "Edited" tag). Required `tx`: an edit re-parses
   * mentions and diffs their rows in the same transaction.
   */
  async update(
    id: string,
    patch: Prisma.CommentUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Comment> {
    return tx.comment.update({ where: { id }, data: patch });
  },

  /**
   * Re-point every comment of one work item onto another (Story 6.11 · Subtask
   * 6.11.5 — mark-duplicate / merge). The triage-merge action folds a duplicate
   * submission's whole comment thread into the canonical item by moving the
   * rows wholesale: `parentCommentId` is untouched, so a root and its replies
   * move together and the one-level thread structure is preserved (mention rows
   * ride along unchanged — they key off `commentId`, not `workItemId`).
   * Required `tx` — this commits atomically with the duplicate's cancel + the
   * `duplicates` link. Returns the number of comments moved.
   */
  async reassignWorkItem(
    fromWorkItemId: string,
    toWorkItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.comment.updateMany({
      where: { workItemId: fromWorkItemId },
      data: { workItemId: toWorkItemId },
    });
    return result.count;
  },

  /**
   * HARD-delete one comment (the Jira-faithful semantics — no tombstone).
   * The DB cascades take the replies (for a root) and every mention row with
   * it; the surviving trace is the `work_item_revision` deletion record the
   * service writes in the SAME transaction (5.1.2) — hence required `tx`.
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<Comment> {
    return tx.comment.delete({ where: { id } });
  },

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Comment | null> {
    const client = tx ?? dbRead;
    return client.comment.findUnique({ where: { id } });
  },

  /**
   * Comments by id, in one read (MOTIR-10240) — the run-record read resolves a
   * run's discrepancy pointers to their bodies with it. An id with no row is
   * simply absent from the answer.
   */
  async findManyByIds(ids: string[], tx: Prisma.TransactionClient): Promise<Comment[]> {
    if (ids.length === 0) return [];
    return tx.comment.findMany({ where: { id: { in: ids } } });
  },

  /**
   * One PAGE of a work item's comment THREADS (Subtask 5.1.1, the read 5.1.2's
   * cursor-paged `listComments` composes): ROOT comments only
   * (`parentCommentId IS NULL`), each carrying its full single-level `replies`
   * thread (ordered oldest-first within the thread — replies always read
   * top-down; bounded by the one-level threading decision, so including them
   * is never an unbounded ride-along). NEVER a load-all (finding #57): `take`
   * caps the page, `cursor` (a root-comment id) resumes strictly after the
   * previous page's last root (`skip: 1`), and `order` flips the page walk —
   * `desc` reads newest-first (the "newest page + Show more comments (N
   * older)" shape), `asc` oldest-first (the Jira default sort).
   *
   * `id` is the required secondary sort: `createdAt` alone is not a total
   * order (same-millisecond writes tie), and an unbroken tie makes cursor
   * paging skip/repeat rows at a page boundary (PRODECT_FINDINGS #38). Backed
   * by the (work_item_id, created_at) index. Read-only path → `db` singleton.
   */
  async listThreadsByWorkItem(
    workItemId: string,
    options: { take?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<CommentWithReplies[]> {
    const client = tx ?? dbRead;
    const { take = 20, cursor, order = 'desc' } = options;
    return client.comment.findMany({
      where: { workItemId, parentCommentId: null },
      include: { replies: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      orderBy: [{ createdAt: order }, { id: order }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * The comment this author already wrote on this item with exactly this body, since
   * `since`, or null: how a retried write recognises its own earlier attempt.
   */
  async findIdenticalSince(
    where: { workItemId: string; authorId: string; bodyMd: string; since: Date },
    tx: Prisma.TransactionClient,
  ): Promise<Comment | null> {
    return tx.comment.findFirst({
      where: {
        workItemId: where.workItemId,
        authorId: where.authorId,
        bodyMd: where.bodyMd,
        createdAt: { gte: where.since },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * The PUBLIC-request comment thread for a work item (Subtask 6.12.12) — ONLY
   * `isPublic` comments, the public feedback thread distinct from the work
   * item's internal Story-5.1 discussion (`isPublic = false`, which never
   * crosses the public projection). Public-request comments are flat (6.12.6
   * always writes `parentCommentId = null`), so this is a flat list, NOT the
   * threaded `listThreadsByWorkItem` read. Bounded (the at-scale rule): the most
   * recent {@link PUBLIC_REQUEST_COMMENT_CAP} comments, then reversed to
   * oldest-first so the composer's optimistic insert appends at the bottom
   * (chronological). `id` is the total-order tiebreak (same-ms writes). A thread
   * longer than the cap drops its OLDEST comments, keeping the recent activity.
   *
   * ⚠️ This used to read: "Read-only path (public detail) → `db` singleton directly,
   * no `tx` param (CLAUDE.md: a read used only by a read-only service path takes no
   * `tx`)." That rule is about TRANSACTIONAL correctness and it is right, but it does
   * not survive RLS: a read-only path still has to say which tenant it is reading.
   *
   * Takes a REQUIRED `tx` (MOTIR-2784). `comment` carries `comment_active_workspace`
   * and NO public arm — MOTIR-2684 added one to `project`, not here — so an unbound
   * read of a public request's thread returns an EMPTY LIST AND RAISES NOTHING, and
   * the public page renders as a request nobody has replied to.
   *
   * Required rather than optional because there is no correct unbound caller: the
   * only caller is the public request detail, which knows the project's workspace and
   * can bind it. Binding the workspace tier is also why this needs no new policy —
   * the existing arm admits the rows once it is told which tenant they belong to, and
   * the `isPublic` filter stays where it is, in the query.
   */
  async listPublicByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<Comment[]> {
    const rows = await tx.comment.findMany({
      where: { workItemId, isPublic: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PUBLIC_REQUEST_COMMENT_CAP,
    });
    return rows.reverse();
  },

  /**
   * How many comments this user WROTE in a workspace — the erasure preview's
   * `anonymised` comment number (MOTIR-3699), read per SHARED workspace.
   *
   * Replies included, `isPublic` comments included: a public-request comment is
   * still something the reader wrote and still carries their name, and §6's
   * promise (*"we anonymise your contributions — your name is removed"*) is
   * about the attribution, not about which surface renders the row.
   *
   * `tx` REQUIRED, unlike its two neighbours: `comment_active_workspace` gates
   * on `app.workspace_id`, and this read is issued once per workspace inside
   * that workspace's own `withWorkspaceContext`. An unbound count would answer
   * zero everywhere and raise nothing — an empty ledger that looks like a reader
   * who never wrote anything.
   */
  async countByAuthorInWorkspace(
    authorId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.comment.count({ where: { workspaceId, authorId } });
  },

  /**
   * How many comments a work item holds — replies INCLUDED (the Activity
   * section's header count: "N comments" counts every comment, not threads).
   * The denominator behind "Show more comments (N older)". Read-only path →
   * `db` singleton.
   */
  async countByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.comment.count({ where: { workItemId } });
  },

  /**
   * How many comments each of MANY work items holds (MOTIR-2001) — the BATCHED
   * sibling of {@link countByWorkItem}, for a whole PAGE of rows. Replies are
   * included, so a bucket here is the same total that read returns for the same
   * id (and the same denominator `commentsService.listComments` reports).
   *
   * ONE query for any page size — a `groupBy` on `work_item_id`, never a loop
   * over `countByWorkItem` (the N+1 the MCP list reads must not ship). Empty
   * input short-circuits WITHOUT touching the DB, matching
   * `workItemLinkRepository.findBlockedEdgesForItems`.
   *
   * SPARSE by construction: an id with no comments produces no row (that is what
   * `GROUP BY` does). Pre-seeding the zero is the SERVICE's job, exactly as the
   * edge projection pre-seeds its empty arrays.
   *
   * `workspaceId` is a required scope, not an option — a count is read on behalf
   * of a caller in one tenant, and the ids come from a page that tenant could
   * already see. Read-only path → `db` singleton.
   */
  async countByWorkItemIds(
    workItemIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ workItemId: string; count: number }[]> {
    if (workItemIds.length === 0) return [];
    const client = tx ?? dbRead;
    const rows = await client.comment.groupBy({
      by: ['workItemId'],
      where: { workItemId: { in: workItemIds }, workspaceId },
      _count: { _all: true },
    });
    return rows.map((row) => ({ workItemId: row.workItemId, count: row._count._all }));
  },

  /**
   * How many replies a ROOT comment holds (Subtask 5.1.2) — the count the
   * delete path records in the `work_item_revision` deletion trace (and the
   * 5.1.5 confirm copy names) BEFORE the cascade takes the thread. Takes `tx`
   * when read inside the delete transaction.
   */
  async countByParent(parentCommentId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.comment.count({ where: { parentCommentId } });
  },

  /**
   * How many ROOT comments (threads) a work item holds — the paging
   * denominator for `listThreadsByWorkItem` (pages walk roots, so "is there
   * another page" is a root count, not a total count).
   */
  async countRootsByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.comment.count({ where: { workItemId, parentCommentId: null } });
  },

  /**
   * A ROOT comment's replies, oldest first (Subtask 5.2.3) — the delete path
   * reads the thread's bodies BEFORE the cascade takes them, so the
   * link-on-write sync can unlink the attachment rows those bodies
   * referenced. Bounded by the single-level-threading rule (replies of one
   * root, never a tree walk). Takes `tx` when read inside the delete
   * transaction.
   */
  async listReplies(parentCommentId: string, tx?: Prisma.TransactionClient): Promise<Comment[]> {
    const client = tx ?? dbRead;
    return client.comment.findMany({
      where: { parentCommentId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Whether ANY comment on the work item still references `text` (Subtask
   * 5.2.3) — the still-referenced-elsewhere guard the unlink path runs per
   * de-referenced blob URL before letting a row go GC-eligible. A bounded
   * existence probe (`findFirst` on the indexed work_item_id, substring match
   * on the candidate bodies), never a table scan; runs inside the write tx so
   * it sees the body state the current write produced.
   */
  async someBodyReferences(
    workItemId: string,
    text: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? dbRead;
    const row = await client.comment.findFirst({
      where: { workItemId, bodyMd: { contains: text } },
      select: { id: true },
    });
    return row !== null;
  },

  /**
   * Every comment BODY on a work item, oldest first (MOTIR-2709) — the read
   * behind the close-out artifact-evidence check
   * (`lib/workItems/artifactEvidence.ts`), which scans them with a regex and so
   * cannot be expressed as {@link someBodyReferences}'s `contains` probe.
   *
   * Replies are INCLUDED: a digest quoted in a reply to "did this actually
   * publish?" is exactly as good a record as one in a root comment, and the
   * evidence check has no interest in thread shape.
   *
   * ⚠️ `tx` is REQUIRED, unlike its neighbours here. The only caller runs inside
   * `applyStatusTransition`'s transaction, where the row is already
   * `FOR UPDATE`-locked and the workspace binding is set — so the read must see
   * THAT snapshot (a comment posted in the same transaction counts), and the
   * `tx ?? dbRead` arm every optional-`tx` read carries would have no caller at all.
   */
  async listBodiesByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.comment.findMany({
      where: { workItemId },
      select: { bodyMd: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.bodyMd);
  },
};
