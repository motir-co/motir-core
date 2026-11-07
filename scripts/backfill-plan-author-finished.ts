/**
 * `pnpm db:backfill:author-finished` — carry every plan already open over to the
 * stored author state (Task MOTIR-10491).
 *
 * THE GAP. MOTIR-10490 stores `authorFinished` on a proposal: a driver sends it
 * when an author session finishes, and core stamps a card written by hand. A card
 * finished BEFORE that shipped carries no key, and no session will come back to
 * send it. Once the readers switch to the stored state, each such card on an open
 * plan would read as unwritten, and the next resume would author it again.
 *
 * THE POPULATION: every `add` with no `authorFinished` key on a `generating`,
 * `planned` or `stale` plan that passes `proposalComplete` under the plan's own
 * explanation rule, holds a body beyond its `Scope BOUNDARY`, and is not targeted
 * by a live author step. One predicate decides it — `carryOverVerdict` in
 * `lib/plans/authorFinishedCarryOver.ts` — and the dry run asks it exactly as the
 * real run does.
 *
 * IT STAMPS ONE KEY AND NOTHING ELSE. A stamped add's proposed fields gain
 * `authorFinished: true`; the plan keeps its status, proposals, timeline and
 * last-activity time, and the plan gate's digest ignores the key, so a person
 * holding a `planned` plan open to approve is not told it moved.
 *
 * IDEMPOTENT: a stamped card reads `already_has_state` next time, so a SECOND RUN
 * STAMPS 0. ONE TRANSACTION PER PLAN, under the plan lock the doors take: one
 * failure does not roll back the rest, and an interrupt keeps its progress.
 *
 * A REAL RUN REPORTS BEFORE AND AFTER. It first prints the dry prediction, then
 * applies, then re-reads the population dry and prints what is left — 0 unless a
 * plan failed or changed underneath it.
 *
 * CROSS-TENANT BY DEFAULT; `--workspace=<id>` narrows to one tenant.
 *
 * Usage:
 *   pnpm db:backfill:author-finished --dry-run              # rehearse: count + print, write nothing
 *   pnpm db:backfill:author-finished                        # apply everywhere
 *   pnpm db:backfill:author-finished --workspace=<id> [--dry-run]
 *
 * It needs only `DATABASE_URL` (no host calls). Do the dry run first, read the
 * per-workspace counts, and only then apply. RUNNING THIS ON PRODUCTION is its own
 * card (MOTIR-10495). On production it runs as the data script
 * `backfill-author-finished` (`scripts/data-script-main.ts`,
 * `docs/runbooks/production-data-scripts.md`), inside a core worker task; the
 * Neon-era workflow that ran it was retired (MOTIR-10573). The `pnpm` command runs that same
 * entry, which loads `.env` and composes the URL before this module loads.
 *
 * SIGINT / SIGTERM stop the sweep between two plans and print the PARTIAL report,
 * marked INTERRUPTED, before exiting non-zero.
 */
import {
  planAuthorFinishedBackfillService,
  type AuthorFinishedBackfillProgress,
  type AuthorFinishedBackfillReport,
} from '@/lib/services/planAuthorFinishedBackfillService';

const TAG = '[backfill-author-finished]';

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

const CONSOLE: Out = console;

function printProgress(out: Out, p: AuthorFinishedBackfillProgress): void {
  out.log(`${TAG} progress ${p.examined}/${p.total} — stamped ${p.stamped}, failed ${p.failed}`);
}

/** The per-workspace table, then one line per stamped plan, then the failures. */
function printReport(out: Out, heading: string, report: AuthorFinishedBackfillReport): void {
  const verb = report.dryRun ? 'would stamp' : 'stamped';
  out.log(`${TAG} ${heading}`);
  if (report.byWorkspace.length === 0) out.log(`${TAG}   no open plans in scope.`);
  for (const w of report.byWorkspace) {
    out.log(
      `${TAG}   workspace ${w.workspaceId}: ${w.stamp} ${verb}, ` +
        `${w.alreadyHasState} already stated, ${w.inFlight} in flight, ` +
        `${w.notComplete} not complete, ${w.boundaryOnly} boundary only, ` +
        `${w.noLongerOpen} plan(s) no longer open, ${w.failed} failed (of ${w.examined} open plan(s))`,
    );
  }
  for (const p of report.plans) {
    out.log(
      `${TAG}     ${verb} ${p.stamped.length} card(s) on ${p.status} plan ${p.planId} ` +
        `(project ${p.projectId})`,
    );
  }
  for (const f of report.failed) out.error(`${TAG}   plan ${f.planId} FAILED — ${f.error}`);
  out.log(
    `${TAG}   total: ${report.stamp} ${verb}, ${report.alreadyHasState} already stated, ` +
      `${report.inFlight} in flight, ${report.notComplete} not complete, ` +
      `${report.boundaryOnly} boundary only, ${report.noLongerOpen} no longer open, ` +
      `${report.failed.length} failed — ${report.examined} of ${report.total} open plan(s) examined.`,
  );
}

/**
 * The whole CLI over an argv: returns the exit code. A real run is bracketed by two
 * dry reads — the stamps it is about to write, and what is left afterwards.
 */
export async function run(
  argv: readonly string[],
  opts: { out?: Out; signal?: AbortSignal } = {},
): Promise<number> {
  const out = opts.out ?? CONSOLE;
  const args = parseArgs(argv);
  const scope = args.workspaceId ? { workspaceId: args.workspaceId } : {};
  const common = {
    ...scope,
    onProgress: (p: AuthorFinishedBackfillProgress) => printProgress(out, p),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  if (args.dryRun) out.log(`${TAG} DRY RUN — judging only, nothing will be written.`);
  out.log(
    `${TAG} scope: ${args.workspaceId ? `workspace ${args.workspaceId}` : 'every workspace'}.`,
  );

  const before = await planAuthorFinishedBackfillService.backfill({ dryRun: true, ...common });
  printReport(out, args.dryRun ? 'PREDICTION:' : 'BEFORE — what this run will stamp:', before);

  let applied: AuthorFinishedBackfillReport | undefined;
  if (!args.dryRun && !before.interrupted) {
    applied = await planAuthorFinishedBackfillService.backfill({ dryRun: false, ...common });
    printReport(out, 'APPLIED:', applied);
    if (!applied.interrupted) {
      const after = await planAuthorFinishedBackfillService.backfill({ dryRun: true, ...common });
      printReport(out, 'AFTER — still to stamp:', after);
    }
  }

  const last = applied ?? before;
  if (last.interrupted) {
    out.error(
      `${TAG} INTERRUPTED after ${last.examined} of ${last.total} plan(s). ` +
        'Stamps already written are kept; re-run to resume.',
    );
    return 1;
  }
  if (last.failed.length > 0) {
    out.error(`${TAG} ${last.failed.length} plan(s) failed — see above.`);
    return 1;
  }
  out.log(`${TAG} done.` + (args.dryRun ? ' Re-run without --dry-run to apply.' : ''));
  return 0;
}

/**
 * The data-script entry's `main` (`scripts/data-script-main.ts`): `run` on the
 * process's own streams, with SIGINT / SIGTERM wired to stop the sweep between two
 * plans — a GitHub Actions timeout or Cancel arrives as SIGINT, then SIGTERM — so
 * the partial report still prints.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return;
    console.error(`${TAG} ${signal} received — stopping after the plan in flight.`);
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
