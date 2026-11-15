/**
 * `pnpm db:backfill:run-discrepancy` — give every run discrepancy record written before
 * Task MOTIR-11361 its structured row, read back from the comment it left.
 *
 * WHY. Since MOTIR-11361 `record_run_discrepancy` stores its points and decisions as data
 * (`run_discrepancy_record` + entries) beside the card comment. A record made before that
 * exists only as the comment, so cross-run analysis, `get_run_record` and the run search's
 * `discrepancy` filter would not see it. `runDiscrepancyBackfillService` holds the rules:
 * findings first (first per leg), then the comments of cards that had no open leg.
 *
 * NOTHING IS DROPPED SILENTLY. A finding whose comment was deleted or edited out of shape
 * gets a `backfill_unreadable` record with the finding's counts and no entries; a header-
 * matched comment that does not parse and has no finding is listed below and not written.
 * Each is printed, with its reason.
 *
 * IDEMPOTENT: a second run writes 0. One transaction per candidate.
 *
 * CROSS-TENANT BY DEFAULT; `--workspace=<id>` narrows to one tenant.
 *
 * Usage:
 *   pnpm db:backfill:run-discrepancy --dry-run              # rehearse: decide + print, write nothing
 *   pnpm db:backfill:run-discrepancy                        # apply everywhere
 *   pnpm db:backfill:run-discrepancy --workspace=<id> [--dry-run]
 *
 * Needs only `DATABASE_URL`. Against production it runs inside AWS as the data script
 * `backfill-run-discrepancy` (`scripts/data-script-main.ts`,
 * `docs/runbooks/production-data-scripts.md`), in a core worker task.
 *
 * SIGINT / SIGTERM stop between two candidates and print the PARTIAL report, marked
 * INTERRUPTED, before exiting non-zero.
 */
import {
  runDiscrepancyBackfillService,
  type RunDiscrepancyBackfillReport,
} from '@/lib/services/runDiscrepancyBackfillService';

const TAG = '[backfill-run-discrepancy]';

export interface Args {
  dryRun: boolean;
  workspaceId: string | undefined;
}

export function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let workspaceId: string | undefined;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--workspace=') && arg.length > '--workspace='.length)
      workspaceId = arg.slice('--workspace='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, workspaceId };
}

/** Where the script writes — injectable so a test reads the lines it printed. */
export interface Out {
  log: (line: string) => void;
  error: (line: string) => void;
}

function printReport(out: Out, report: RunDiscrepancyBackfillReport): void {
  for (const u of report.unreadable) {
    out.log(
      `${TAG}   UNREADABLE ${u.from} ${u.id} on card ${u.workItemId}: ${u.reason}` +
        (u.from === 'finding'
          ? ` — ${report.dryRun ? 'would be kept' : 'kept'} as a backfill_unreadable record with its counts`
          : ' — not written: no finding says it was a record'),
    );
  }
  for (const s of report.skipped) out.log(`${TAG}   SKIPPED finding ${s.id}: ${s.reason}`);
  for (const f of report.failed) out.error(`${TAG}   ${f.id} FAILED — ${f.error}`);
  out.log(
    `${TAG} ${report.dryRun ? 'would backfill' : 'backfilled'} ${report.backfilled}, ` +
      `unreadable ${report.unreadable.length}, already recorded ${report.alreadyRecorded}, ` +
      `skipped ${report.skipped.length}, failed ${report.failed.length} — ` +
      `${report.examined} of ${report.total} candidate(s) examined.`,
  );
}

/** The whole CLI over an argv: returns the exit code. */
export async function run(
  argv: readonly string[],
  opts: { out?: Out; signal?: AbortSignal } = {},
): Promise<number> {
  const out = opts.out ?? console;
  const args = parseArgs(argv);
  if (args.dryRun) out.log(`${TAG} DRY RUN — deciding only, nothing will be written.`);
  out.log(
    `${TAG} scope: ${args.workspaceId ? `workspace ${args.workspaceId}` : 'every workspace'}.`,
  );
  const report = await runDiscrepancyBackfillService.backfill({
    dryRun: args.dryRun,
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  printReport(out, report);
  if (report.interrupted) {
    out.error(
      `${TAG} INTERRUPTED after ${report.examined} of ${report.total} candidate(s). ` +
        'Records already written are kept; re-run to resume.',
    );
    return 1;
  }
  if (report.failed.length > 0) {
    out.error(`${TAG} ${report.failed.length} candidate(s) failed — see above.`);
    return 1;
  }
  out.log(`${TAG} done.` + (args.dryRun ? ' Re-run without --dry-run to apply.' : ''));
  return 0;
}

/** The data-script entry's `main`: `run` on the process's streams, SIGINT / SIGTERM wired. */
export async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return;
    console.error(`${TAG} ${signal} received — stopping after the candidate in flight.`);
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await run(argv, { signal: controller.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
