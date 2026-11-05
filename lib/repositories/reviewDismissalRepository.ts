import { Prisma, type ReviewDismissal } from '@/generated/prisma/client';
import { ReviewSendBackAlreadyDismissedError } from '@/lib/agentReview/errors';

// Single Prisma operations on `review_dismissal` (Story MOTIR-10327 · MOTIR-10334;
// `approval-gates.md` §12.15) — a person's dismissal of a standing agent send-back. No
// business logic, no transactions: `reviewDismissalService` owns those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`: the table's RLS policy gates every row on
// `app.workspace_id`, so an UNBOUND read matches nothing — and "no dismissal" would then
// read as a send-back that still stands.
//
// ⚠️ APPEND ONLY. Nothing here updates or deletes a row.

/** One dismissal to append, as the service names it. */
export interface ReviewDismissalCreateRow {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  /** Exactly one of the two send-back references is set (the migration's CHECK). */
  reviewVerdictRecordId: string | null;
  approvalGateId: string | null;
  subjectVersion: string;
  reasonMd: string;
  dismissedById: string;
}

/** A dismissal with the person who made it — what the review line names. */
export type ReviewDismissalWithPerson = ReviewDismissal & {
  dismissedBy: { id: string; name: string | null } | null;
};

export const reviewDismissalRepository = {
  /**
   * Append one dismissal. A (card, version) already dismissed hits the unique index and
   * is translated to {@link ReviewSendBackAlreadyDismissedError} — the backstop for two
   * concurrent dismissals that both passed the read under the lock's predecessor.
   */
  async create(
    row: ReviewDismissalCreateRow,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewDismissal> {
    try {
      return await tx.reviewDismissal.create({ data: row });
    } catch (err) {
      // Under FORCE RLS PostgreSQL declines to describe the conflicting key, so the code
      // is the only reliable signal (the `approvalGateRepository.create` note).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ReviewSendBackAlreadyDismissedError(row.subjectVersion);
      }
      throw err;
    }
  },

  /** The dismissal at a version, or null. */
  async findAt(
    workItemId: string,
    subjectVersion: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewDismissalWithPerson | null> {
    return tx.reviewDismissal.findUnique({
      where: { workItemId_subjectVersion: { workItemId, subjectVersion } },
      include: { dismissedBy: { select: { id: true, name: true } } },
    });
  },

  /** The card's newest dismissal, whatever its version, or null. */
  async findLatestByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewDismissal | null> {
    return tx.reviewDismissal.findFirst({
      where: { workItemId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** Every dismissal on the card, NEWEST FIRST, with who made it. */
  async listByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewDismissalWithPerson[]> {
    return tx.reviewDismissal.findMany({
      where: { workItemId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { dismissedBy: { select: { id: true, name: true } } },
    });
  },
};
