import type { Prisma } from '@/generated/prisma/client';

// Decision-page publication repository — single operations on
// `decision_page_publication` (Story MOTIR-5761 · MOTIR-7428;
// `docs/decisions/approval-gates.md` §8 NINTH AMENDMENT, clause 1). One row per
// publish, append-only; the NEWEST row for a work item is its published page.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included — `pageVersionRepository`'s
// reasoning: the table carries the workspace policy pair and no system arm, so an
// UNBOUND read returns nothing and raises nothing.

/** One publication, as every read returns it. */
export interface DecisionPagePublicationRecord {
  id: string;
  workItemId: string;
  pageId: string;
  pageVersionId: string;
  publishedById: string;
  publishedAt: Date;
}

/** What `insert` writes. */
export interface DecisionPagePublicationInsert {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  pageId: string;
  pageVersionId: string;
  publishedById: string;
  publishedAt: Date;
}

const PUBLICATION_SELECT = {
  id: true,
  workItemId: true,
  pageId: true,
  pageVersionId: true,
  publishedById: true,
  publishedAt: true,
} as const;

export const decisionPagePublicationRepository = {
  async insert(
    data: DecisionPagePublicationInsert,
    tx: Prisma.TransactionClient,
  ): Promise<DecisionPagePublicationRecord> {
    return tx.decisionPagePublication.create({ data, select: PUBLICATION_SELECT });
  },

  /** The work item's published page — its newest publication — or `null`. */
  async latestForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DecisionPagePublicationRecord | null> {
    return tx.decisionPagePublication.findFirst({
      where: { workItemId },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: PUBLICATION_SELECT,
    });
  },

  /**
   * Each work item's published page, for many at once — the To-approve row's subject
   * (MOTIR-7436): the newest publication per item, with the page's title and the
   * version's number. Items with no publication are absent.
   */
  async latestForWorkItems(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<
      DecisionPagePublicationRecord & {
        pageTitle: string;
        pageArchivedAt: Date | null;
        versionNumber: number;
      }
    >
  > {
    if (workItemIds.length === 0) return [];
    const rows = await tx.decisionPagePublication.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      distinct: ['workItemId'],
      orderBy: [{ workItemId: 'asc' }, { publishedAt: 'desc' }, { id: 'desc' }],
      select: {
        ...PUBLICATION_SELECT,
        page: { select: { title: true, archivedAt: true } },
        pageVersion: { select: { number: true } },
      },
    });
    return rows.map(({ page, pageVersion, ...row }) => ({
      ...row,
      pageTitle: page.title,
      pageArchivedAt: page.archivedAt,
      versionNumber: pageVersion.number,
    }));
  },

  /**
   * The DECISION TAG of each of these page versions (MOTIR-7436, History's delta 5): the
   * card that FROZE it (its approving gate's card), or else the card whose AWAITING
   * `decision_approval` asks about it. One statement for the whole history page; a
   * version with neither is absent.
   */
  async decisionTagsForVersions(
    versionIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ versionId: string; frozenKey: string | null; publishedKey: string | null }>> {
    if (versionIds.length === 0) return [];
    return tx.$queryRaw`
      SELECT pv."id" AS "versionId",
             fw."identifier" AS "frozenKey",
             (
               SELECT w."identifier"
               FROM "decision_page_publication" p
               JOIN "work_item" w ON w."id" = p."work_item_id"
               WHERE p."page_version_id" = pv."id"
                 AND EXISTS (
                   SELECT 1 FROM "approval_gate" ag
                   WHERE ag."work_item_id" = p."work_item_id"
                     AND ag."kind" = 'decision_approval'
                     AND ag."state" = 'awaiting'
                 )
               ORDER BY p."published_at" DESC
               LIMIT 1
             ) AS "publishedKey"
      FROM "page_version" pv
      LEFT JOIN "approval_gate" fg ON fg."id" = pv."frozen_by_gate_id"
      LEFT JOIN "work_item" fw ON fw."id" = fg."work_item_id"
      WHERE pv."id" = ANY(${[...versionIds]})
        AND (pv."frozen_by_gate_id" IS NOT NULL OR pv."sealed_at" IS NOT NULL)`;
  },
};
