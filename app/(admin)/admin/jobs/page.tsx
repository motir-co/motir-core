import type { Metadata } from 'next';
import type { JobRunStatus, PlatformDlqListDTO } from '@/lib/dto/jobs';
import { JOBS_SYSTEM_REPLAY_ROLE } from '@/lib/jobs/platformStanding';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformJobReplayService } from '@/lib/services/platformJobReplayService';
import { platformJobsLedgerService } from '@/lib/services/platformJobsLedgerService';
import { DeadLettersSection } from './_components/DeadLettersSection';
import { JobsFrame } from './_components/JobsFrame';
import { Pager } from './_components/Pager';
import { RunsTable } from './_components/RunsTable';
import { SectionError } from './_components/SectionError';
import { RUN_STATUSES, StatusFilter } from './_components/StatusFilter';

/**
 * The platform job ledger — design `platform-admin/design-notes.md` § AMENDMENT
 * 2026-10-28 — Jobs (card MOTIR-9987, story MOTIR-9980). Every background job
 * the platform ran, in every workspace and in none, and every dead letter
 * waiting; an operator replays them one at a time or a whole function at once.
 *
 * ⚠️ NO FORK OF `/settings/workspace/jobs`. The workspace manager's ledger is
 * untouched; this page reads through its own staff-gated services and copies
 * only the row anatomy.
 *
 * ⚠️ THE ROLE DECIDES WHAT IS DRAWN, NOT WHAT IS ALLOWED. Support sees every row
 * and no replay control; the actions and the services refuse below operator
 * whatever this page draws. Viewing is audited by the `(admin)` layout, so the
 * page records nothing itself.
 *
 * Every filter lives in the URL (`tab`, `status`, `page`, `fn`), because each
 * changes what the server must answer.
 */

export const metadata: Metadata = {
  // No description, as on the console's other pages: the route's existence is
  // never confirmable to a non-staff caller.
  title: 'Jobs',
};

/** Never cached: a ledger read from a cache would show a replayed row as waiting. */
export const dynamic = 'force-dynamic';

/** Runs per page — the design's 50. */
const RUNS_PAGE_SIZE = 50;

type Settled<T> = { status: 'ok'; data: T } | { status: 'failed' };

/** Settle one read so its failure stays in its own section (the page keeps its shell). */
async function settle<T>(label: string, read: Promise<T>): Promise<Settled<T>> {
  try {
    return { status: 'ok', data: await read };
  } catch (err) {
    console.error(`[admin/jobs] the ${label} read failed`, {
      detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
    return { status: 'failed' };
  }
}

function statusParam(value: string | undefined): JobRunStatus | undefined {
  return RUN_STATUSES.find((status) => status === value);
}

function pageParam(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; status?: string; page?: string; fn?: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const params = await searchParams;
  const now = new Date();
  const tab = params.tab === 'dlq' ? 'dlq' : 'runs';
  const canReplay = platformRoleAtLeast(principal.role, JOBS_SYSTEM_REPLAY_ROLE);
  const platformRole = principal.role;

  if (tab === 'runs') {
    const status = statusParam(params.status);
    const page = pageParam(params.page);
    const [runs, dlq] = await Promise.all([
      settle(
        'runs',
        platformJobsLedgerService.listRuns({
          platformRole,
          status,
          limit: RUNS_PAGE_SIZE,
          offset: (page - 1) * RUNS_PAGE_SIZE,
        }),
      ),
      // Read for the Dead letters tab's waiting count only.
      settle('dead letters', platformJobsLedgerService.listDeadLetters({ platformRole, now })),
    ]);
    return (
      <JobsFrame waiting={dlq.status === 'ok' ? dlq.data.unreplayedTotal : null} tab="runs">
        <StatusFilter status={status} />
        {runs.status === 'ok' ? (
          <>
            <RunsTable rows={runs.data.rows} status={status} now={now} />
            <Pager page={page} hasMore={runs.data.hasMore} status={status} />
          </>
        ) : (
          <SectionError which="runs" />
        )}
      </JobsFrame>
    );
  }

  const requested = params.fn?.trim() || null;
  const [first, requestedCount] = await Promise.all([
    settle(
      'dead letters',
      platformJobsLedgerService.listDeadLetters({
        platformRole,
        functionId: requested ?? undefined,
        now,
      }),
    ),
    // The number the Replay all confirm names. Advisory: the action enumerates
    // again. A failed count only withholds Replay all.
    canReplay && requested
      ? settle(
          'replay-all count',
          platformJobReplayService.countUnreplayedDeadLetters({
            functionId: requested,
            principal,
          }),
        )
      : Promise.resolve(null),
  ]);

  // A `fn` the read no longer lists (all of it replayed, or never real) falls
  // back to All functions, and the list is read again unfiltered.
  let dlq: Settled<PlatformDlqListDTO> = first;
  let fn = requested;
  if (
    first.status === 'ok' &&
    requested &&
    !first.data.functions.some((f) => f.functionId === requested)
  ) {
    fn = null;
    dlq = await settle(
      'dead letters',
      platformJobsLedgerService.listDeadLetters({ platformRole, now }),
    );
  }
  const replayAllCount =
    fn !== null && requestedCount?.status === 'ok' ? requestedCount.data : null;

  return (
    <JobsFrame waiting={dlq.status === 'ok' ? dlq.data.unreplayedTotal : null} tab="dlq">
      {dlq.status === 'ok' ? (
        <DeadLettersSection
          list={dlq.data}
          fn={fn}
          canReplay={canReplay}
          replayAllCount={replayAllCount}
          now={now}
        />
      ) : (
        <SectionError which="dlq" />
      )}
    </JobsFrame>
  );
}
