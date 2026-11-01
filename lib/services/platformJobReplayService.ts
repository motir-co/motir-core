import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { replayDLQ as replayDlqInTx, type ReplayDLQResult } from '@/lib/jobs/dlq';
import {
  DlqEntryNotFoundError,
  PlatformJobsReadForbiddenError,
  SystemReplayForbiddenError,
} from '@/lib/jobs/errors';
import { JOBS_SYSTEM_READ_ROLE, JOBS_SYSTEM_REPLAY_ROLE } from '@/lib/jobs/platformStanding';
import { platformRoleAtLeast, type PlatformPrincipal } from '@/lib/platform/auth';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { toJobRunDlqDTO } from '@/lib/mappers/jobMappers';
import type { ReplayAllResultDTO } from '@/lib/dto/jobs';

// The platform job ledger's REPLAY door (MOTIR-9985): an `operator` replays one
// dead letter from /admin/jobs, a workspace's or a workspace-less one, and the
// replay is written to the platform audit log.
//
// It is the only replay door left: the tenant dashboard's manager-gated replay
// and its System tab's workspace-less replay were deleted with that dashboard
// (Story MOTIR-9982). Unlike the System tab's door it takes a row that has a
// workspace as readily as one that has none.
//
// ⚠️ TWO TRANSACTIONS, NEVER NESTED. The replay runs under `withSystemContext`
// (`app.system_admin`, the only binding that admits every tenant's row); the
// audit row is written by `platformAuditService.record`, which opens
// `withPlatformRead` (`app.platform_staff` plus the audit chain lock). The two
// contexts bind different GUCs and neither may be opened inside the other, so
// the audit row is written AFTER the replay commits. If that write fails, the
// replay stands, the error is rethrown so the operator sees it, and the
// `[jobs.replay]` warn line written inside the replay is the fallback record.

/** How many dead letters Replay all reads per batch (MOTIR-9986). */
export const REPLAY_ALL_BATCH_SIZE = 50;

/** The reason written on every replay row — the screen has no per-row reason field. */
export const DLQ_REPLAY_AUDIT_REASON = 'Dead letter replayed from /admin/jobs';

export const platformJobReplayService = {
  /**
   * Replay ONE dead letter. Refuses below `operator` before any transaction,
   * answers an unknown id with `DlqEntryNotFoundError`, and delegates the
   * re-emit and the `replayed_at` stamp to lib/jobs/dlq.ts so the
   * `:replay:<dlqId>` key and the `already-replayed` outcome are the other
   * doors'. Holds no state between calls: Replay all calls it once per row.
   */
  async replayOne(input: {
    dlqId: string;
    principal: PlatformPrincipal;
  }): Promise<ReplayDLQResult> {
    const { dlqId, principal } = input;
    if (!platformRoleAtLeast(principal.role, JOBS_SYSTEM_REPLAY_ROLE)) {
      throw new SystemReplayForbiddenError(principal.userId);
    }

    const { entry, result } = await withSystemContext(async (tx) => {
      const entry = await jobRunDlqRepository.findById(dlqId, tx);
      if (!entry) throw new DlqEntryNotFoundError(dlqId);

      // A row already stamped was replayed by someone else. The re-emit's own
      // dedup catches that only for a job that declares an idempotency template,
      // so the stamp is read first: Replay all must never send a raced row twice.
      const result: ReplayDLQResult =
        entry.replayedAt !== null
          ? { outcome: 'already-replayed', entry: toJobRunDlqDTO(entry) }
          : await replayDlqInTx(dlqId, tx);

      // The warn-level line every replay door has written; `door` names this one.
      console.warn(
        '[jobs.replay]',
        JSON.stringify({
          dlqId,
          workspaceId: entry.workspaceId,
          actorUserId: principal.userId,
          functionId: entry.functionId,
          eventName: entry.eventName,
          door: 'platform',
          outcome: result.outcome,
        }),
      );

      return { entry, result };
    });

    // An already-replayed row replayed nothing, so it records nothing.
    if (result.outcome === 'replayed') {
      await platformAuditService.record(principal, {
        action: 'jobs.dlq_replay',
        targetKind: 'platform',
        targetId: dlqId,
        targetLabel: entry.functionId,
        reason: DLQ_REPLAY_AUDIT_REASON,
        metadata: {
          dlqId,
          functionId: entry.functionId,
          eventName: entry.eventName,
          hasWorkspace: entry.workspaceId !== null,
          workspaceId: entry.workspaceId,
        },
      });
    }

    return result;
  },

  /**
   * Replay every unreplayed dead letter of ONE function (MOTIR-9986). Refuses
   * below `operator` before any read. Reads the ids in keyset batches of
   * {@link REPLAY_ALL_BATCH_SIZE} and replays each through {@link replayOne}, so
   * every row is its own transaction and its own audit row: a row that throws
   * is counted in `failed` and cannot roll back its neighbours, and the cursor
   * (not the unreplayed predicate) keeps it from being read again. No
   * transaction is held across rows.
   */
  async replayAllDeadLettersForFunction(input: {
    functionId: string;
    principal: PlatformPrincipal;
  }): Promise<ReplayAllResultDTO> {
    const { functionId, principal } = input;
    if (!platformRoleAtLeast(principal.role, JOBS_SYSTEM_REPLAY_ROLE)) {
      throw new SystemReplayForbiddenError(principal.userId);
    }

    const out: ReplayAllResultDTO = { functionId, replayed: 0, alreadyReplayed: 0, failed: [] };
    let after: { lastFailedAt: Date; id: string } | undefined;
    for (;;) {
      const batch = await withSystemContext((tx) =>
        jobRunDlqRepository.listUnreplayedIdsForFunction(
          { functionId, take: REPLAY_ALL_BATCH_SIZE, after },
          tx,
        ),
      );
      for (const row of batch) {
        try {
          const result = await platformJobReplayService.replayOne({ dlqId: row.id, principal });
          if (result.outcome === 'replayed') out.replayed += 1;
          else out.alreadyReplayed += 1;
        } catch (err) {
          // A refusal of the caller is not a per-row failure; it ends the run.
          if (err instanceof SystemReplayForbiddenError) throw err;
          // A row deleted since its batch was read has nothing left to replay.
          if (err instanceof DlqEntryNotFoundError) continue;
          out.failed.push(row.id);
        }
      }
      if (batch.length < REPLAY_ALL_BATCH_SIZE) break;
      after = batch[batch.length - 1];
    }
    return out;
  },

  /**
   * How many of one function's dead letters wait to be replayed — the number
   * the Replay all confirm names. A read, so it asks for `support`.
   */
  async countUnreplayedDeadLetters(input: {
    functionId: string;
    principal: PlatformPrincipal;
  }): Promise<number> {
    if (!platformRoleAtLeast(input.principal.role, JOBS_SYSTEM_READ_ROLE)) {
      throw new PlatformJobsReadForbiddenError();
    }
    return withSystemContext((tx) =>
      jobRunDlqRepository.countUnreplayedForFunction({ functionId: input.functionId }, tx),
    );
  },
};
