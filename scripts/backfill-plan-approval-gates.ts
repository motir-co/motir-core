/**
 * `pnpm db:backfill:plan-gates` — raise the missing `plan_approval` gate on every
 * plan that was ALREADY `planned` when the plan gate shipped (Story MOTIR-6012 ·
 * Subtask MOTIR-6039; ADR `docs/decisions/approval-gates.md` §11.9).
 *
 * THE GAP. MOTIR-6036 raises a plan's gate when the plan closes to `planned`. A plan
 * that closed before that has none, so it is missing from To approve and, after the
 * decide doors (MOTIR-6038), reads as "not decidable yet". Nothing will raise it
 * later: the close that raises has already happened.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE RAISE. Every plan is handed to
 * `planGateService.raise` — the same function `markPlanned` calls — which takes the
 * plan lock first, routes per §11.6 (the requester, else the workspace owner) and
 * inserts through the card-less awaiting-uniqueness index.
 *
 * THE POPULATION: every `planned` plan with at least one proposal and no `awaiting`
 * `plan_approval` gate. A `stale`, `approved`, `declined` or `generating` plan is
 * never a candidate; a `planned` plan with no proposals, or one already asked, is
 * examined and left alone (counted, so the abstention is visible).
 *
 * IDEMPOTENT BY CONSTRUCTION: a plan that already has an awaiting gate is a no-op
 * (the raise's `ON CONFLICT DO NOTHING` on the index), so a SECOND RUN RAISES 0.
 * `--dry-run` asks `planGateService.assess`, which shares the raise's own predicate,
 * so it predicts a real run exactly and writes / routes nothing. ONE TRANSACTION PER
 * PLAN: one failure does not roll back the rest, and an interrupt keeps its progress.
 *
 * A REAL RUN REPORTS BEFORE AND AFTER. It first prints the dry prediction (what it
 * is about to change), then applies, then re-reads the population dry and prints
 * what is left — which is 0 unless a plan failed or changed underneath it.
 *
 * CROSS-TENANT BY DEFAULT; `--workspace=<id>` narrows to one tenant.
 *
 * Usage:
 *   pnpm db:backfill:plan-gates --dry-run              # rehearse: count + print, write nothing
 *   pnpm db:backfill:plan-gates                        # apply everywhere
 *   pnpm db:backfill:plan-gates --workspace=<id> [--dry-run]
 *
 * It needs only `DATABASE_URL` (no host calls):
 *
 *   DATABASE_URL='<core direct url>' pnpm db:backfill:plan-gates --dry-run
 *
 * Do the dry run first, read the per-workspace counts, and only then apply.
 * RUNNING THIS ON PRODUCTION is an operator step after the deploy, owed as its own
 * `manual` card — not MOTIR-6039's.
 *
 * SIGINT / SIGTERM stop the sweep between two plans and print the PARTIAL report,
 * marked INTERRUPTED, before exiting non-zero.
 */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import {
  planGateBackfillService,
  type PlanGateBackfillProgress,
  type PlanGateBackfillReport,
} from '@/lib/services/planGateBackfillService';

const TAG = '[backfill-plan-gates]';

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

function printProgress(out: Out, p: PlanGateBackfillProgress): void {
  out.log(`${TAG} progress ${p.examined}/${p.total} — raised ${p.raised}, failed ${p.failed}`);
}

/** The per-workspace table, then one line per raised plan, then the failures. */
function printReport(out: Out, heading: string, report: PlanGateBackfillReport): void {
  const verb = report.dryRun ? 'would raise' : 'raised';
  out.log(`${TAG} ${heading}`);
  if (report.byWorkspace.length === 0) out.log(`${TAG}   no \`planned\` plans in scope.`);
  for (const w of report.byWorkspace) {
    out.log(
      `${TAG}   workspace ${w.workspaceId}: ${w.raise} ${verb}, ` +
        `${w.alreadyAwaiting} already awaiting, ${w.noProposals} with no proposals, ` +
        `${w.notPlanned} no longer planned, ${w.failed} failed (of ${w.examined} planned)`,
    );
  }
  for (const r of report.raised) {
    out.log(
      `${TAG}     ${verb} plan ${r.planId} (project ${r.projectId}) → ` +
        (r.routedToId ? `routed to ${r.routedToId}` : 'routed to NOBODY (workspace has no owner)'),
    );
  }
  for (const f of report.failed) out.error(`${TAG}   plan ${f.planId} FAILED — ${f.error}`);
  out.log(
    `${TAG}   total: ${report.raised.length} ${verb}, ${report.alreadyAwaiting} already awaiting, ` +
      `${report.noProposals} with no proposals, ${report.notPlanned} no longer planned, ` +
      `${report.failed.length} failed — ${report.examined} of ${report.total} planned plan(s) examined.`,
  );
}

/**
 * The whole CLI over an argv: returns the exit code. A real run is bracketed by two
 * dry reads — the counts it is about to change, and what is left afterwards.
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
    onProgress: (p: PlanGateBackfillProgress) => printProgress(out, p),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  if (args.dryRun) out.log(`${TAG} DRY RUN — assessing only, nothing will be written.`);
  out.log(
    `${TAG} scope: ${args.workspaceId ? `workspace ${args.workspaceId}` : 'every workspace'}.`,
  );

  const before = await planGateBackfillService.backfill({ dryRun: true, ...common });
  printReport(out, args.dryRun ? 'PREDICTION:' : 'BEFORE — what this run will change:', before);

  let applied: PlanGateBackfillReport | undefined;
  if (!args.dryRun && !before.interrupted) {
    applied = await planGateBackfillService.backfill({ dryRun: false, ...common });
    printReport(out, 'APPLIED:', applied);
    if (!applied.interrupted) {
      const after = await planGateBackfillService.backfill({ dryRun: true, ...common });
      printReport(out, 'AFTER — still lacking a gate:', after);
    }
  }

  const last = applied ?? before;
  if (last.interrupted) {
    out.error(
      `${TAG} INTERRUPTED after ${last.examined} of ${last.total} plan(s). ` +
        'Gates already raised are kept; re-run to resume.',
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

/* v8 ignore start -- the process entry: signal wiring and exit code over `run`,
   which `tests/approvalGates/planGateBackfill.test.ts` drives directly. */
if (/backfill-plan-approval-gates\.ts$/.test(process.argv[1] ?? '')) {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return;
    console.error(`${TAG} ${signal} received — stopping after the plan in flight.`);
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  run(process.argv.slice(2), { signal: controller.signal })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`${TAG} failed:`, err);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
/* v8 ignore stop */
