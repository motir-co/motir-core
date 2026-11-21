import type { Prisma } from '@/generated/prisma/client';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';

// ONE REVIEW OF AN ITEM AT A TIME, ACROSS EVERY DOOR (Story MOTIR-11941 · MOTIR-11945;
// `approval-gates.md` §12.18). Two doors open a review run — *Review with Motir agent* (a
// hosted run) and *Review in my agent* (a run in the person's own agent) — and each keys its
// run differently: a hosted press by its attempt number, an own-agent press by the person's
// request key. A deterministic key collapses two presses of ONE door; it cannot collapse a
// press of each door, nor two own-agent presses with different request keys. So every review
// open decides and inserts under one lock on the ITEM:
//
//   1. a transaction-scoped advisory lock on `review-open:<workItemId>` — a second open of
//      the same item waits here until the first commits or rolls back;
//   2. the same press again (its key already opened a run) passes through, so the open
//      answers that run (`created: false`);
//   3. otherwise any RUNNING `review` run with a leg on the item refuses the open.
//
// Called from `dispatchRunService.open`'s `beforeOpen`, inside the open's own transaction,
// so the lock is released by the commit that makes the new run visible to the next open.

/**
 * Take the item's review lock and answer the review already running for it, or null when
 * this open may proceed. A run already opened under `idempotencyKey` answers null: the open
 * then returns that run as the repeat it is.
 */
export async function reviewInFlightUnderLock(
  tx: Prisma.TransactionClient,
  target: { workspaceId: string; workItemId: string; idempotencyKey: string },
): Promise<{ id: string } | null> {
  const lockKey = `review-open:${target.workItemId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const repeat = await dispatchRunRepository.findByIdempotencyKey(
    target.workspaceId,
    target.idempotencyKey,
    tx,
  );
  if (repeat) return null;
  return dispatchRunRepository.findRunningReviewByWorkItem(target.workItemId, tx);
}
