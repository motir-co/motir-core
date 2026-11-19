/**
 * `pnpm db:backfill:aws-costs` — load Motir's AWS cost history into the Costs page's
 * store (MOTIR-11712), a month at a time, newest first.
 *
 * WHY. The scheduled fetch (`system.aws-cost-fetch`) keeps the current and the previous
 * month. Everything older is read once, here: Cost Explorer holds 13 months by default
 * and 38 with multi-year data on, and the walk stops at the first month it no longer
 * holds (or at `--max-months`).
 *
 * ⚠️ EVERY MONTH IS A BILLED READ (about $0.01 per paginated request). `--dry-run` reads
 * nothing and lists the months a run would ask for.
 *
 * IDEMPOTENT: a month is replaced whole in one transaction, so a re-run converges.
 *
 * Usage:
 *   pnpm db:backfill:aws-costs --dry-run            # list the months; read and write nothing
 *   pnpm db:backfill:aws-costs                      # read back to Cost Explorer's limit
 *   pnpm db:backfill:aws-costs --max-months=13      # at most 13 months back, this one included
 *
 * Needs `DATABASE_URL` and `AWS_COST_EXPLORER_ROLE_ARN`, with credentials allowed to
 * assume that role. Against production it runs inside AWS as the data script
 * `backfill-aws-costs` (`scripts/data-script-main.ts`,
 * `docs/runbooks/production-data-scripts.md`), in a core worker task — whose role the
 * management account's Cost Explorer role trusts.
 *
 * SIGINT / SIGTERM stop between two months and print what was stored, marked INTERRUPTED,
 * before exiting non-zero.
 */
import {
  AWS_COST_BACKFILL_MAX_MONTHS,
  awsCostService,
  type AwsCostBackfillReport,
} from '@/lib/services/awsCostService';
import type { CostExplorerReader } from '@/lib/awsCost/costExplorerReader';

const TAG = '[backfill-aws-costs]';
const MAX_MONTHS_FLAG = '--max-months=';

export interface Args {
  dryRun: boolean;
  maxMonths: number;
}

export function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let maxMonths = AWS_COST_BACKFILL_MAX_MONTHS;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith(MAX_MONTHS_FLAG)) {
      const value = Number(arg.slice(MAX_MONTHS_FLAG.length));
      if (!Number.isInteger(value) || value < 3 || value > AWS_COST_BACKFILL_MAX_MONTHS) {
        throw new Error(
          `${TAG} ${MAX_MONTHS_FLAG} takes a whole number from 3 to ${AWS_COST_BACKFILL_MAX_MONTHS}`,
        );
      }
      maxMonths = value;
    } else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, maxMonths };
}

/** Where the script writes — injectable so a test reads the lines it printed. */
export interface Out {
  log: (line: string) => void;
  error: (line: string) => void;
}

const STOPPED_BY: Record<AwsCostBackfillReport['stoppedBy'], string> = {
  history_unavailable: 'Cost Explorer holds no older month',
  max_months: 'reached --max-months',
  interrupted: 'INTERRUPTED',
  not_configured: 'not configured',
};

/** The whole CLI over an argv: returns the exit code. */
export async function run(
  argv: readonly string[],
  opts: { out?: Out; signal?: AbortSignal; reader?: CostExplorerReader; now?: Date } = {},
): Promise<number> {
  const out = opts.out ?? console;
  const args = parseArgs(argv);
  if (args.dryRun) out.log(`${TAG} DRY RUN — nothing will be read or written.`);
  const report = await awsCostService.backfill({
    maxMonths: args.maxMonths,
    dryRun: args.dryRun,
    ...(opts.reader ? { reader: opts.reader } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onMonth: (month, lines) => out.log(`${TAG}   ${month}: stored ${lines} line(s).`),
  });
  if (args.dryRun) {
    out.log(
      `${TAG} would read ${report.planned.length} month(s), newest first: ` +
        `${report.planned.join(', ') || 'none'}. Each is one billed Cost Explorer request or more.`,
    );
    out.log(`${TAG} done. Re-run without --dry-run to read them.`);
    return 0;
  }
  if (report.stoppedBy === 'not_configured') {
    out.error(`${TAG} AWS_COST_EXPLORER_ROLE_ARN is not set — nothing was read.`);
    return 1;
  }
  out.log(
    `${TAG} stored ${report.months.length} month(s)` +
      (report.months.length > 0
        ? ` (${report.months[0]} back to ${report.months[report.months.length - 1]})`
        : '') +
      ` — stopped: ${STOPPED_BY[report.stoppedBy]}.`,
  );
  if (report.stoppedBy === 'interrupted') {
    out.error(`${TAG} INTERRUPTED. Months already stored are kept; re-run to finish.`);
    return 1;
  }
  out.log(`${TAG} done.`);
  return 0;
}

/** The data-script entry's `main`: `run` on the process's streams, SIGINT / SIGTERM wired. */
export async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return;
    console.error(`${TAG} ${signal} received — stopping after the month in flight.`);
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
