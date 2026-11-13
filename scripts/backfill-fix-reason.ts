/**
 * `pnpm db:backfill:fix-reason` — recompute `WorkItem.fixReason` for every live card
 * through the shipped recompute (Story MOTIR-6588 · MOTIR-6603). The shape is
 * `pnpm db:backfill:ci-state`'s (MOTIR-5472), deliberately.
 *
 * WHY. The wiring (MOTIR-6602) recomputes the reason on every future event. A card
 * already stuck when it deploys has no next event coming, so it reads `null` for ever
 * and never appears on the Workbench's To fix tab — and those long-forgotten cards are
 * the ones the tab exists to surface.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE RULE. Every card is handed to
 * `fixReasonService.recomputeWorkItemFixReason`, the function the live path calls,
 * which reads `motir fix`'s own predicate.
 *
 * CANDIDATES: every card in an `in_progress`-category status, plus any card still
 * carrying a reason (so a stale one is cleared). ARCHIVED cards are skipped and
 * counted. IDEMPOTENT: a second run reports `changed: 0`. The dry run derives through
 * the same code without the lock or the write, so it predicts a real run exactly.
 *
 * CROSS-TENANT BY DEFAULT; `--workspace=<id>` narrows to one tenant.
 *
 * Usage:
 *   pnpm db:backfill:fix-reason --dry-run              # rehearse: derive + print, write nothing
 *   pnpm db:backfill:fix-reason                        # apply everywhere
 *   pnpm db:backfill:fix-reason --workspace=<id>
 *
 * Needs only `DATABASE_URL` — every input the rule reads is already recorded:
 *
 *   DATABASE_URL='<core direct url>' pnpm db:backfill:fix-reason --dry-run
 *
 * Against production it runs inside AWS, never from a laptop: Amazon RDS admits
 * only core's services, so it is `node /app/data/data-script.mjs backfill-fix-reason` in a core
 * worker task (`docs/runbooks/production-data-scripts.md`).
 *
 * A progress line every `FIX_REASON_BACKFILL_PROGRESS_EVERY` cards; SIGINT / SIGTERM
 * stop between two cards and print the PARTIAL report, marked INTERRUPTED.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
// Run through `scripts/data-script-main.ts` (MOTIR-10465): the entry loads `.env`,
// composes `DATABASE_URL` in a Fargate task, and ends the pool after `main` answers.
import { workItemFixReasonBackfillService } from '@/lib/services/workItemFixReasonBackfillService';
import type {
  FixReasonBackfillProgress,
  FixReasonBackfillReport,
} from '@/lib/services/workItemFixReasonBackfillService';

const TAG = '[backfill-fix-reason]';

interface Args {
  dryRun: boolean;
  workspaceId: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let workspaceId: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--workspace=')) workspaceId = arg.slice('--workspace='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, workspaceId };
}

/** `null` prints as a word rather than as nothing — an empty cell in a
 *  `from → to` pair is unreadable, and "nothing to fix" is a real answer. */
function show(state: string | null): string {
  return state ?? 'none';
}

function printProgress(p: FixReasonBackfillProgress): void {
  console.log(
    `${TAG} progress ${p.examined}/${p.total} — scanned ${p.scanned}, ` +
      `changed ${p.changed}, unchanged ${p.unchanged}, ` +
      `archived ${p.skippedArchived}, failed ${p.failed}`,
  );
}

function printReport(report: FixReasonBackfillReport): void {
  const { dryRun } = report;

  // The population by reason AFTER the sweep — what the To fix tab will hold.
  for (const [reason, count] of Object.entries(report.byReason)) {
    console.log(`${TAG}   ${dryRun ? 'would read' : 'reads'} ${reason}: ${count} card(s)`);
  }
  // Of those, the ones a pushed fix is running CI on — listed under their reason above.
  console.log(`${TAG}   ${dryRun ? 'would read' : 'reads'} Fixing: ${report.fixing} card(s)`);

  // The per-transition breakdown, which is what an operator reads to decide
  // whether the sweep did what they expected.
  const byTransition = new Map<string, number>();
  for (const change of report.changed) {
    const key = `${show(change.from)} → ${show(change.to)}`;
    byTransition.set(key, (byTransition.get(key) ?? 0) + 1);
  }
  for (const [transition, count] of [...byTransition].sort((a, b) => b[1] - a[1])) {
    console.log(`${TAG}   ${dryRun ? 'would change' : 'changed'} ${count} card(s): ${transition}`);
  }

  for (const change of report.changed) {
    console.log(
      `${TAG}     ${change.identifier} (${change.workItemId}): ` +
        `${show(change.from)} → ${show(change.to)}`,
    );
  }

  for (const failure of report.failed) {
    console.error(`${TAG}   ${failure.workItemId} FAILED — ${failure.error}`);
  }
}

/** Runs the backfill on `argv`; answers the exit code (1 on an interrupted or failed card). */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.dryRun) console.log(`${TAG} DRY RUN — deriving only, nothing will be written.`);
  console.log(
    `${TAG} scope: ${args.workspaceId ? `workspace ${args.workspaceId}` : 'every workspace'}.`,
  );

  // A timeout or a Cancel in GitHub Actions arrives as SIGINT, then SIGTERM a few
  // seconds later. Either one ABORTS rather than exits, so the loop stops at the
  // next card boundary and the partial report below still gets printed.
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return;
    console.error(`${TAG} ${signal} received — stopping after the card in flight.`);
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const report = await workItemFixReasonBackfillService.backfillFixReason({
    dryRun: args.dryRun,
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    onProgress: printProgress,
    signal: controller.signal,
  });
  printReport(report);

  if (report.interrupted) {
    // The counts are REAL but PARTIAL: say so on the summary line itself, so
    // nobody pastes them as the whole sweep. A re-run resumes cheaply — every
    // card already correct is a no-op.
    console.error(
      `${TAG} INTERRUPTED after ${report.scanned} of ${report.total} card(s) — ` +
        `${report.changed.length} ${args.dryRun ? 'would change' : 'changed'}, ` +
        `${report.unchanged} already correct, ` +
        `${report.skippedArchived} archived (skipped), ` +
        `${report.failed.length} failed. The rest were NOT examined.`,
    );
    return 1;
  }

  console.log(
    `${TAG} done — ${report.scanned} of ${report.total} candidate card(s) scanned, ` +
      `${report.changed.length} ${args.dryRun ? 'would change' : 'changed'}, ` +
      `${report.unchanged} already correct, ` +
      `${report.skippedArchived} archived (skipped), ` +
      `${report.failed.length} failed.` +
      (args.dryRun ? ' Re-run without --dry-run to apply.' : ''),
  );

  // A failed card is a NON-ZERO exit even though the sweep completed: an operator
  // piping this into a check must not read "some cards still carry a wrong
  // reason" as success.
  if (report.failed.length > 0) {
    console.error(`${TAG} ${report.failed.length} card(s) failed — see above.`);
    return 1;
  }
  return 0;
}
