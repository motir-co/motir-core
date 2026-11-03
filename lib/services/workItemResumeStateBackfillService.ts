import type { WorkItemResumeState } from '@/generated/prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { deriveResumeState, recomputeWorkItemResumeState } from './resumeStateService';

// BACKFILL `WorkItem.resumeState` FOR THE CARDS THAT ALREADY EXIST (Story MOTIR-7701 ·
// MOTIR-7707). The fix-reason backfill (`workItemFixReasonBackfillService`) is the
// precedent, and this keeps its shape: the live recompute decides every card, one
// transaction per card, idempotent, and a dry run that derives through the same code
// without the lock or the write.
//
// Why one is owed: a run that already closed `gated` before the column existed has no
// next event coming, so its cards would read `null` and never reach To resume.
// The same sweep converges a card the derivation now answers differently: one whose
// delivery set started CI after its gated run ended (MOTIR-10308) is cleared, through the
// same `recomputeWorkItemResumeState`, with no per-card step.

export interface ResumeStateBackfillChange {
  workItemId: string;
  identifier: string;
  from: WorkItemResumeState | null;
  to: WorkItemResumeState | null;
}

export interface ResumeStateBackfillReport {
  dryRun: boolean;
  scanned: number;
  changed: ResumeStateBackfillChange[];
  unchanged: number;
  failed: Array<{ workItemId: string; error: string }>;
}

export interface ResumeStateBackfillOptions {
  dryRun: boolean;
  workspaceId?: string;
}

export const workItemResumeStateBackfillService = {
  async backfillResumeState(opts: ResumeStateBackfillOptions): Promise<ResumeStateBackfillReport> {
    const workspaceIds = await withSystemContext((tx) =>
      workspaceRepository.listIds(tx, opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    );
    const report: ResumeStateBackfillReport = {
      dryRun: opts.dryRun,
      scanned: 0,
      changed: [],
      unchanged: 0,
      failed: [],
    };
    for (const workspaceId of workspaceIds) {
      const ids = await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, workspaceId);
        return workItemRepository.listResumeStateBackfillCandidateIds(workspaceId, tx);
      });
      for (const workItemId of ids) {
        try {
          const outcome = await withSystemContext(async (tx) => {
            await bindWorkspaceContext(tx, workspaceId);
            const item = await workItemRepository.findById(workItemId, tx);
            /* v8 ignore next -- a card deleted between the candidate read and this one */
            if (!item) return null;
            const to = opts.dryRun
              ? (await deriveResumeState(item, tx)).resumeState
              : (await recomputeWorkItemResumeState(workItemId, tx)).resumeState;
            return { identifier: item.identifier, from: item.resumeState, to };
          });
          /* v8 ignore next -- the other half of the race arm above */
          if (!outcome) continue;
          report.scanned += 1;
          if (outcome.from === outcome.to) report.unchanged += 1;
          else report.changed.push({ workItemId, ...outcome });
        } catch (err) {
          report.scanned += 1;
          report.failed.push({
            workItemId,
            /* v8 ignore next -- the non-`Error` throw */
            error: err instanceof Error ? err.message : 'unknown error',
          });
        }
      }
    }
    return report;
  },
};
