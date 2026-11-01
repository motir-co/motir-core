import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { toJobRunDlqDTO } from '@/lib/mappers/jobMappers';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  jobsDashboardService,
  SYSTEM_DLQ_REPLAYED_WINDOW_DAYS,
} from '@/lib/services/jobsDashboardService';
import { PlatformJobsReadForbiddenError } from '@/lib/jobs/errors';
import { JOBS_SYSTEM_READ_ROLE } from '@/lib/jobs/platformStanding';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import type { PlatformRole } from '@/generated/prisma/client';
import type { JobRunStatus, PlatformDlqListDTO, PlatformRunsPageDTO } from '@/lib/dto/jobs';

// The READ half of the platform job ledger at /admin/jobs (MOTIR-9984): every
// run and every dead letter, of every workspace and of none.
//
// ⚠️ Both reads run under `withSystemContext`, which bypasses tenant RLS, so the
// role check below is the whole gate. The caller resolves the principal fresh
// per request (`requirePlatformStaffPage` on the page, `requirePlatformStaff`
// in its actions) and hands its role in; the page's 404 is a second line.
//
// This read replaced the tenant dashboard's `listSystemDlq`, which was
// workspace-less only and capped at the newest 200 across every function, so a
// function's older rows were unreachable (MOTIR-9957). That read was deleted
// with the tenant dashboard (Story MOTIR-9982).

/**
 * The cap on each half of the dead-letter list, PER SELECTION: with a function
 * chosen it bounds that function's rows only, so choosing it reaches rows older
 * than the newest 200 overall. The counts beside the rows are true counts.
 */
export const PLATFORM_DLQ_LIST_CAP = 200;

function assertCanRead(platformRole: PlatformRole | null): void {
  if (!platformRole || !platformRoleAtLeast(platformRole, JOBS_SYSTEM_READ_ROLE)) {
    throw new PlatformJobsReadForbiddenError();
  }
}

export const platformJobsLedgerService = {
  /**
   * One page of runs across every workspace plus the workspace-less ones,
   * newest first, optionally of one status. Reads `limit + 1` rows so the page
   * can say whether another follows without a count query.
   */
  async listRuns(input: {
    platformRole: PlatformRole | null;
    status?: JobRunStatus;
    limit: number;
    offset: number;
  }): Promise<PlatformRunsPageDTO> {
    assertCanRead(input.platformRole);
    const rows = await jobsDashboardService.listSystemRuns({
      status: input.status,
      limit: input.limit + 1,
      offset: input.offset,
    });
    return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  },

  /**
   * The dead letters: every unreplayed one, newest failure first, then those
   * replayed within {@link SYSTEM_DLQ_REPLAYED_WINDOW_DAYS}; `functionId`
   * narrows both halves. Carries the filter's options — every function with an
   * unreplayed row and its true count, most first — and the true totals.
   */
  async listDeadLetters(input: {
    platformRole: PlatformRole | null;
    functionId?: string;
    now?: Date;
  }): Promise<PlatformDlqListDTO> {
    assertCanRead(input.platformRole);
    const now = input.now ?? new Date();
    const since = new Date(now.getTime() - SYSTEM_DLQ_REPLAYED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const functionId = input.functionId || undefined;
    return withSystemContext(async (tx) => {
      const [unreplayed, replayed, depths, replayedRecently] = await Promise.all([
        jobRunDlqRepository.listUnreplayed({ functionId, take: PLATFORM_DLQ_LIST_CAP }, tx),
        jobRunDlqRepository.listReplayedSince(
          { since, functionId, take: PLATFORM_DLQ_LIST_CAP },
          tx,
        ),
        jobRunDlqRepository.standingDepthByFunction(tx),
        jobRunDlqRepository.countReplayedSince({ since, functionId }, tx),
      ]);
      const functions = depths
        .map((d) => ({ functionId: d.functionId, unreplayed: d.standing }))
        .sort((a, b) => b.unreplayed - a.unreplayed || a.functionId.localeCompare(b.functionId));
      return {
        rows: [...unreplayed, ...replayed].map(toJobRunDlqDTO),
        functions,
        unreplayedTotal: functions.reduce((sum, f) => sum + f.unreplayed, 0),
        replayedRecently,
      };
    });
  },
};
