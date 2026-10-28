import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { replayDLQ as replayDlqInTx, type ReplayDLQResult } from '@/lib/jobs/dlq';
import { DlqEntryNotFoundError, SystemReplayForbiddenError } from '@/lib/jobs/errors';
import { JOBS_SYSTEM_REPLAY_ROLE } from '@/lib/jobs/platformStanding';
import { platformRoleAtLeast, type PlatformPrincipal } from '@/lib/platform/auth';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { toJobRunDlqDTO } from '@/lib/mappers/jobMappers';

// The platform job ledger's REPLAY door (MOTIR-9985): an `operator` replays one
// dead letter from /admin/jobs, a workspace's or a workspace-less one, and the
// replay is written to the platform audit log.
//
// It is `jobsDashboardService.replaySystemDLQ`'s shape minus that door's one
// refusal: the system door refuses a row that has a workspace, and this one is
// the staff door that takes it. Both keep working; neither is altered.
//
// ⚠️ TWO TRANSACTIONS, NEVER NESTED. The replay runs under `withSystemContext`
// (`app.system_admin`, the only binding that admits every tenant's row); the
// audit row is written by `platformAuditService.record`, which opens
// `withPlatformRead` (`app.platform_staff` plus the audit chain lock). The two
// contexts bind different GUCs and neither may be opened inside the other, so
// the audit row is written AFTER the replay commits. If that write fails, the
// replay stands, the error is rethrown so the operator sees it, and the
// `[jobs.replay]` warn line written inside the replay is the fallback record.

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

      // The same warn-level line the other two doors write; `door` tells them apart.
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
};
