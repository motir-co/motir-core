import {
  Prisma,
  type ReviewVerdictOutcome,
  type ReviewVerdictRecord,
} from '@/generated/prisma/client';
import { ReviewVerdictAnswerExistsError } from '@/lib/agentReview/errors';

// Single Prisma operations on `review_verdict_record` (Story MOTIR-10327 · MOTIR-10333;
// `approval-gates.md` §12.11–§12.13) — every agent review verdict, from the hosted run's
// route or a person's own review agent through the user-token door. No business logic,
// no transactions: `reviewVerdictService` and `agentReviewRunService` own those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`: the table's own RLS policy gates every row on
// `app.workspace_id`, so an UNBOUND read matches nothing rather than failing, and an empty
// history reads exactly like "nobody reviewed this card".
//
// ⚠️ APPEND ONLY. A verdict is history: a late or second one decides nothing and is kept
// all the same. Nothing here updates or deletes a row.

/** One verdict to append, as the services name it. */
export interface ReviewVerdictRecordCreateRow {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  gateId: string | null;
  subjectVersion: string;
  verdict: 'pass' | 'changes_requested';
  outcome: ReviewVerdictOutcome;
  summaryMd: string | null;
  findingsMd: string | null;
  checklist: Prisma.InputJsonValue;
  submittedById: string | null;
  harness: string;
  model: string;
}

/** The outcomes that ANSWER a version — at most one per (card, version). */
const ANSWERING: ReviewVerdictOutcome[] = ['decided', 'recorded'];

export const reviewVerdictRecordRepository = {
  /**
   * Append one verdict. An ANSWERING row (`decided` / `recorded`) for a (card, version)
   * that already has one hits the partial unique index
   * `review_verdict_record_one_answer_per_version`, translated to
   * {@link ReviewVerdictAnswerExistsError}. The violation aborts the caller's transaction,
   * so the caller catches it OUTSIDE and writes the verdict again as `second`.
   */
  async create(
    row: ReviewVerdictRecordCreateRow,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewVerdictRecord> {
    try {
      return await tx.reviewVerdictRecord.create({ data: row });
    } catch (err) {
      // Under FORCE RLS PostgreSQL declines to describe the conflicting key, so the code
      // is the only reliable signal (the `approvalGateRepository.create` note).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ReviewVerdictAnswerExistsError(row.workItemId, row.subjectVersion);
      }
      throw err;
    }
  },

  /** The ANSWERING verdict at a version — `decided` or `recorded` — or null. */
  async findAnswerAt(
    workItemId: string,
    subjectVersion: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewVerdictRecord | null> {
    return tx.reviewVerdictRecord.findFirst({
      where: { workItemId, subjectVersion, outcome: { in: ANSWERING } },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * The GATE-OFF send-back standing at a version — a `recorded` `changes_requested` — or
   * null. A gate-on send-back is the decided `agent_review` gate itself, read there.
   */
  async findRecordedSendBackAt(
    workItemId: string,
    subjectVersion: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewVerdictRecord | null> {
    return tx.reviewVerdictRecord.findFirst({
      where: { workItemId, subjectVersion, outcome: 'recorded', verdict: 'changes_requested' },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** The newest GATE-OFF send-back on the card, whatever its version, or null. */
  async findLatestRecordedSendBack(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewVerdictRecord | null> {
    return tx.reviewVerdictRecord.findFirst({
      where: { workItemId, outcome: 'recorded', verdict: 'changes_requested' },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Every verdict on the card, NEWEST FIRST — the card's review history. */
  async listByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewVerdictRecord[]> {
    return tx.reviewVerdictRecord.findMany({
      where: { workItemId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
