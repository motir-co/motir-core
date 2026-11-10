import type { Prisma } from '@/generated/prisma/client';
import { PAGE_COMMENT_RECORD_SELECT, type PageCommentRecord } from '@/lib/mappers/pageMappers';

// Page-comment repository — single operations on `page_comment` (Story
// MOTIR-10866 · MOTIR-10872). The persistence leaf under the `PageStore`
// adapter's comment methods: no rules and no mapping. `@motir/pages` decides
// what is written (`comments.ts`), and the page-comment service owns the
// transaction and the workspace context.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included — `page_comment` carries
// the page policy pair and no system or public arm, so an UNBOUND read returns
// nothing and raises nothing.

/** The keyset a root list pages after. */
export interface PageCommentRootSeek {
  at: Date;
  id: string;
}

export interface PageCommentRootsRead {
  pageId: string;
  status: 'open' | 'resolved';
  order: 'asc' | 'desc';
  after: PageCommentRootSeek | null;
  limit: number;
}

/** What `insert` writes — the unchecked create shape, ids rather than relations. */
export type PageCommentCreateInput = Prisma.PageCommentUncheckedCreateInput;

export const pageCommentRepository = {
  /**
   * One page of a page's ROOTS. Open roots key on `(createdAt, id)` and
   * resolved ones on `(resolvedAt, id)` — the columns of
   * `page_comment_open_roots_idx` and `page_comment_resolved_roots_idx`, whose
   * predicates the `where` repeats so the planner can use them.
   */
  async findRoots(
    read: PageCommentRootsRead,
    tx: Prisma.TransactionClient,
  ): Promise<PageCommentRecord[]> {
    const column = read.status === 'open' ? 'createdAt' : 'resolvedAt';
    const past = read.order === 'asc' ? 'gt' : 'lt';
    const where: Prisma.PageCommentWhereInput = {
      pageId: read.pageId,
      parentCommentId: null,
      resolvedAt: read.status === 'open' ? null : { not: null },
    };
    if (read.after) {
      where.OR = [
        { [column]: { [past]: read.after.at } },
        { [column]: read.after.at, id: { [past]: read.after.id } },
      ];
    }
    return tx.pageComment.findMany({
      where,
      orderBy: [{ [column]: read.order }, { id: read.order }],
      take: read.limit,
      select: PAGE_COMMENT_RECORD_SELECT,
    });
  },

  /** Every reply of the given roots, oldest first. */
  async findReplies(
    rootIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<PageCommentRecord[]> {
    return tx.pageComment.findMany({
      where: { parentCommentId: { in: [...rootIds] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: PAGE_COMMENT_RECORD_SELECT,
    });
  },

  /** How many open and resolved roots a page has, in one grouped read. */
  async countRoots(
    pageId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ open: number; resolved: number }> {
    const rows = await tx.$queryRaw<{ open: bigint; resolved: bigint }[]>`
      SELECT count(*) FILTER (WHERE "resolved_at" IS NULL)     AS "open",
             count(*) FILTER (WHERE "resolved_at" IS NOT NULL) AS "resolved"
        FROM "page_comment"
       WHERE "page_id" = ${pageId} AND "parent_comment_id" IS NULL
    `;
    // An aggregate with no GROUP BY always answers exactly one row.
    const [row] = rows;
    return { open: Number(row!.open), resolved: Number(row!.resolved) };
  },

  /** Takes one comment's row lock; whether a visible row was there to lock. */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "page_comment" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows.length > 0;
  },

  async findById(id: string, tx: Prisma.TransactionClient): Promise<PageCommentRecord | null> {
    return tx.pageComment.findUnique({ where: { id }, select: PAGE_COMMENT_RECORD_SELECT });
  },

  async insert(
    data: PageCommentCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PageCommentRecord> {
    return tx.pageComment.create({ data, select: PAGE_COMMENT_RECORD_SELECT });
  },

  async updateBody(
    id: string,
    bodyMd: string,
    editedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<PageCommentRecord> {
    return tx.pageComment.update({
      where: { id },
      data: { bodyMd, editedAt },
      select: PAGE_COMMENT_RECORD_SELECT,
    });
  },

  /** Deletes one comment; `parent_comment_id ON DELETE CASCADE` takes a root's replies. */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.pageComment.delete({ where: { id }, select: { id: true } });
  },

  async setResolved(
    id: string,
    resolvedAt: Date | null,
    resolvedById: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<PageCommentRecord> {
    return tx.pageComment.update({
      where: { id },
      data: { resolvedAt, resolvedById },
      select: PAGE_COMMENT_RECORD_SELECT,
    });
  },
};
