import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { toJobRunDTO } from '@/lib/mappers/jobMappers';
import { emailDeliveryRepository } from '@/lib/repositories/emailDeliveryRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import type { JobRunDTO, JobRunStatus } from '@/lib/dto/jobs';

// The cross-tenant run READ behind /admin/jobs (Story 1.6 · Subtask 1.6.5,
// narrowed by MOTIR-10044). The COUNTERPART to jobRunsService: that service is
// the trusted WRITER (it runs under withSystemContext because the job runtime
// has no workspace context), while this one is the platform ledger's runs read,
// joined to each send's delivery record. Its only caller is
// `platformJobsLedgerService`, which checks the requester's platform standing
// first.
//
// The tenant dashboard this file was named for is retired (Story MOTIR-9982):
// its workspace reads, its manager-gated replay and the System tab's
// workspace-less list and replay went with it. Dead letters are read and
// replayed at /admin/jobs through `platformJobsLedgerService` and
// `platformJobReplayService`.
//
// Why a separate service file and not more methods on jobRunsService: the writer
// and the reader have opposite callers (runtime vs. HTTP request). Keeping them
// apart stops a future edit from mixing the runtime's writes into a read path.

/**
 * How long a REPLAYED dead letter stays on the /admin/jobs Dead letters list —
 * long enough to confirm the replay landed, short enough that the list stays a
 * queue (`design/jobs/design-notes.md` § System dead letters, MOTIR-8084).
 */
export const SYSTEM_DLQ_REPLAYED_WINDOW_DAYS = 7;

/**
 * Join each run to its message's delivery record (Bug MOTIR-3507 · Subtask
 * MOTIR-3517), in ONE extra query for the whole page.
 *
 * The join key is `idempotencyKey`, which is on the run ledger and on the
 * delivery row and indexed on both. It is deliberately NOT the engine's run id:
 * that id means different things on the two lanes (a `job_queue` cuid on the
 * Postgres engine, an Inngest ULID on the other), whereas the send key is the
 * payload's own and is identical either way.
 *
 * Runs with no key, and runs that are not `email.send`, are skipped before the
 * query — so a page whose jobs are all reindexes pays nothing for this.
 * `tx` is threaded from the caller's context binding, so the lookup is scoped
 * by the same RLS the runs read was.
 */
async function withDeliveries(
  runs: Awaited<ReturnType<typeof jobRunRepository.listAll>>,
  tx: Parameters<typeof emailDeliveryRepository.listByIdempotencyKeys>[1],
): Promise<JobRunDTO[]> {
  const keys = [
    ...new Set(
      runs
        .filter((run) => run.functionId === EMAIL_SEND_FUNCTION_ID)
        .map((run) => run.idempotencyKey)
        .filter((key): key is string => key !== null),
    ),
  ];
  const deliveries = await emailDeliveryRepository.listByIdempotencyKeys(keys, tx);
  const byKey = new Map(
    deliveries
      .filter((row) => row.idempotencyKey !== null)
      .map((row) => [row.idempotencyKey as string, row]),
  );
  return runs.map((run) =>
    toJobRunDTO(run, run.idempotencyKey === null ? null : (byKey.get(run.idempotencyKey) ?? null)),
  );
}

/** The one job whose runs carry a delivery record. */
const EMAIL_SEND_FUNCTION_ID = 'email.send';

export const jobsDashboardService = {
  /**
   * Every run across all workspaces, INCLUDING untenanted system rows. Runs
   * under withSystemContext (the only context whose RLS branch admits null-
   * workspace rows). The CALLER must verify the requester holds platform-staff
   * standing (`support` or above) before invoking this — the service trusts that gate (same shape as the
   * workspace settings page resolving membership before listMembers).
   */
  async listSystemRuns(input: {
    status?: JobRunStatus;
    limit: number;
    offset: number;
  }): Promise<JobRunDTO[]> {
    return withSystemContext(async (tx) => {
      const rows = await jobRunRepository.listAll(
        { status: input.status, limit: input.limit, offset: input.offset },
        tx,
      );
      // The system view is the one place an UNTENANTED delivery is visible —
      // a password reset carries a null workspace on both the run and its
      // delivery row, so only this binding's RLS branch admits either.
      return withDeliveries(rows, tx);
    });
  },
};
