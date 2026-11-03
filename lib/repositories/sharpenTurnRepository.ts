import {
  Prisma,
  type SharpenAction,
  type SharpenTurn,
  type SharpenTurnRole,
} from '@/generated/prisma/client';

// Single Prisma operations on the `sharpen_turn` table (Task MOTIR-1101 ·
// Subtask MOTIR-8182) — the ordered transcript of a Sharpen session. Its own
// repository because the entity is the turn, not the session (the
// entity-name-wins rule). Writes require `tx`, and so do the reads: the turn
// table's own RLS policy gates every row on `app.workspace_id`, and a turn is
// only ever read inside the door's workspace transaction.
//
// `seq` is gapless per session. The door allocates it the way every other
// transcript in the product does (`planNarrationRepository`): take the session's
// row lock (`sharpenSessionRepository.lockById`), read {@link nextSeq} under it,
// then {@link appendTurn}. `UNIQUE (session_id, seq)` is the backstop that turns
// a lost race into an error instead of two turns at one position.

/** One turn as the door appends it. */
export interface SharpenTurnAppend {
  workspaceId: string;
  role: SharpenTurnRole;
  /** The person's action; omit on a planner turn. */
  action?: SharpenAction | null;
  body: string;
  readingId?: string | null;
  jobId?: string | null;
  /** The planner's result as returned — stored as given. */
  record?: unknown;
  authorId?: string | null;
}

export const sharpenTurnRepository = {
  /** The `seq` the next turn takes: one past the session's highest, 0 on an
   *  empty session. Read it under the session's row lock. */
  async nextSeq(sessionId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.sharpenTurn.aggregate({ where: { sessionId }, _max: { seq: true } });
    return r._max.seq === null ? 0 : r._max.seq + 1;
  },

  /** Append one turn at `seq`. A second planner turn for the same job fails the
   *  partial unique index (P2002) — a replayed settle cannot store it twice. */
  async appendTurn(
    sessionId: string,
    seq: number,
    turn: SharpenTurnAppend,
    tx: Prisma.TransactionClient,
  ): Promise<SharpenTurn> {
    return tx.sharpenTurn.create({
      data: {
        workspaceId: turn.workspaceId,
        sessionId,
        seq,
        role: turn.role,
        action: turn.action ?? null,
        body: turn.body,
        readingId: turn.readingId ?? null,
        jobId: turn.jobId ?? null,
        record:
          turn.record === undefined || turn.record === null
            ? Prisma.DbNull
            : (turn.record as Prisma.InputJsonValue),
        authorId: turn.authorId ?? null,
      },
    });
  },

  /** The session's whole transcript, in `seq` order. */
  async listTurns(sessionId: string, tx: Prisma.TransactionClient): Promise<SharpenTurn[]> {
    return tx.sharpenTurn.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
  },

  /** The turn of this session bound to a job, in a given role — the person turn
   *  that submitted it, or the planner turn that settled it. */
  async findTurnByJob(
    sessionId: string,
    jobId: string,
    role: SharpenTurnRole,
    tx: Prisma.TransactionClient,
  ): Promise<SharpenTurn | null> {
    return tx.sharpenTurn.findFirst({ where: { sessionId, jobId, role } });
  },

  /** The PERSON turn that submitted a job, found by the job, within one project of the
   *  bound workspace and among ONE person's sessions (MOTIR-10235) — the owner a
   *  conversation note reported by the job hangs on. Null when no such turn carries the
   *  job yet. */
  async findPersonTurnByJobForUser(
    jobId: string,
    scope: { projectId: string; workspaceId: string; userId: string },
    tx: Prisma.TransactionClient,
  ): Promise<{ sessionId: string } | null> {
    return tx.sharpenTurn.findFirst({
      where: {
        jobId,
        workspaceId: scope.workspaceId,
        role: 'person',
        session: { projectId: scope.projectId, createdById: scope.userId },
      },
      select: { sessionId: true },
    });
  },

  /** Bind a submitted job to the person turn that asked for it. */
  async setTurnJob(turnId: string, jobId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.sharpenTurn.update({ where: { id: turnId }, data: { jobId }, select: { id: true } });
  },
};
