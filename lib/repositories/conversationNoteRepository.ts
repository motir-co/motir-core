import type { ConversationNote, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `conversation_note` (MOTIR-10235) — what a
// conversation job (a Grill me read, an answering session) said while it worked.
// No business logic, no transactions, no DTO mapping: `conversationNoteService`
// owns those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`: the table's own RLS policy gates every row
// on `app.workspace_id`, so an UNBOUND read matches nothing rather than failing,
// and an empty history reads exactly like "the job said nothing".
//
// ⚠️ NO DELETE, AND NO UPDATE OF A NOTE. Kept history, as `plan_narration`: the
// only thing that removes a row is its owner's cascade.

/** One note to append, as the service names it. */
export interface ConversationNoteCreateRow {
  workspaceId: string;
  jobId: string;
  seq: number;
  body: string;
  sharpenSessionId: string | null;
  planChangeSessionId: string | null;
}

/** Who a set of notes hangs on: a Grill me session or a plan-change conversation. */
export type ConversationNoteOwner = { sharpenSessionId: string } | { planChangeSessionId: string };

export const conversationNoteRepository = {
  /** Serialize one job's appends for the rest of the transaction, so two batches
   *  of the same job cannot read the same `maxSeq` (the `folderRepository` lock). */
  async lockJob(jobId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conversation-note:${jobId}`}, 0))`;
  },

  /** The job's highest `seq`, or 0 when it has none. */
  async maxSeq(jobId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.conversationNote.aggregate({ where: { jobId }, _max: { seq: true } });
    return r._max.seq ?? 0;
  },

  /** Append notes. Returns the rows as stored, in `seq` order. */
  async createMany(
    rows: readonly ConversationNoteCreateRow[],
    tx: Prisma.TransactionClient,
  ): Promise<ConversationNote[]> {
    const created = await tx.conversationNote.createManyAndReturn({ data: [...rows] });
    return created.sort((a, b) => a.seq - b.seq);
  },

  /** The owner's newest `limit` notes, returned OLDEST FIRST (by time, then `seq`). */
  async listLatestByOwner(
    owner: ConversationNoteOwner,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<ConversationNote[]> {
    const rows = await tx.conversationNote.findMany({
      where: owner,
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: limit,
    });
    return rows.reverse();
  },
};
