// =================================================================
// Revision-audit service for the work-item domain (Subtask 1.4.6). Every
// workItemsService write — create / update / archive / link / unlink — calls
// `recordRevision` to persist ONE audit row describing the mutation, INSIDE
// the same transaction as the mutation itself. The required `tx` parameter is
// the contract that enforces this: a revision commits atomically with the
// mutation it describes, or neither does. If the work-item write lands but the
// revision write throws (or vice versa), the enclosing $transaction rolls back
// BOTH — the audit trail can never silently diverge from the data. The
// atomicity integration test (tests/integration/work-items/revisions.test.ts)
// exercises exactly this rollback.
//
// The signature + RecordRevisionArgs shape were locked in by Subtask 1.4.4
// (which shipped this file as a no-op stub so every call site already passed
// the right args). 1.4.6 swapped the body from no-op to a real persist via
// workItemRevisionRepository — call sites are unchanged.
//
// Layer rules (CLAUDE.md): this service owns no transaction of its own — it is
// always invoked inside the caller's $transaction and threads the caller's
// `tx` straight into the repository write (single-op leaf). It performs no DTO
// mapping (it returns only the created row's id; reads + mapping live on the
// read path).

import type { Prisma } from '@/generated/prisma/client';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';

/**
 * The audit verb for a revision row — mirrors WorkItemRevisionDto.changeKind.
 * `comment_deleted` (Story 5.1 · Subtask 5.1.2) records that a comment on the
 * work item was HARD-deleted — the row itself is gone (no tombstone), so this
 * revision is the surviving History trace Story 5.5 renders. The DB column is
 * plain text, so the new kind needs no migration (the designed extension
 * point — see workItemRevisionMappers).
 *
 * `deleted` (Story 2.8 · Subtask 2.8.2) is the same shape one level up: when a
 * work item is PERMANENTLY deleted with its subtree, the deleted rows — and
 * their own revisions (FK `onDelete: Cascade`) — are gone, so the audit trace
 * is recorded on the deleted root's SURVIVING PARENT (diff `{ deleted: { from:
 * '<identifier>: <title> …', to: null } }`). A top-level item (no parent) has
 * no surviving anchor; see `deleteWorkItem`.
 */
export type RevisionChangeKind =
  | 'created'
  | 'updated'
  | 'archived'
  | 'unarchived'
  | 'comment_deleted'
  | 'deleted'
  // An agent's review verdict was recorded (Story MOTIR-10327 · MOTIR-10338) — written
  // by `reviewVerdictRecordService` beside every verdict record, diff
  // `{ agentVerdict: { from: null, to: <snapshot> } }` (`lib/agentReview/verdictActivity.ts`).
  | 'agent_verdict';

/**
 * The arguments a service write passes when recording a revision. `diff` is
 * intentionally loose (`Record<string, unknown>`) so it accommodates BOTH
 * the field-diff shape ({ title: { from, to }, … }) the create/update/move
 * paths produce AND the link-diff shape ({ links: { added: [...] } }) the
 * link/unlink paths produce. The persisted column is JSON; the
 * WorkItemRevisionDto pins the wire shape at the read boundary.
 */
export interface RecordRevisionArgs {
  workItemId: string;
  changedById: string;
  changeKind: RevisionChangeKind;
  diff: Record<string, unknown>;
}

export const workItemRevisionsService = {
  /**
   * Record a revision row for a work-item mutation, inside the caller's
   * transaction (required `tx` — a revision must commit atomically with the
   * mutation it describes, or not at all). Returns the created revision's id —
   * the description-mention path (5.1.6) carries it on the
   * `work-item/mentioned` event as the notification idempotency scope
   * (revision × user); other call sites are free to ignore it.
   */
  async recordRevision(args: RecordRevisionArgs, tx: Prisma.TransactionClient): Promise<string> {
    const row = await workItemRevisionRepository.create(
      {
        workItemId: args.workItemId,
        changedById: args.changedById,
        changeKind: args.changeKind,
        diff: args.diff as Prisma.InputJsonValue,
      },
      tx,
    );
    return row.id;
  },
};
