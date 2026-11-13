/**
 * `pnpm db:backfill:ci-state` — recompute `WorkItem.ciState` for every card that
 * has pull requests, through the shipped recompute (MOTIR-5472) — and for every
 * non-archived card that still stores a verdict with no pull request left, which
 * the recompute folds to `null` (MOTIR-10542).
 *
 * THE DEFECT. `WorkItem.ciState` had one writer, and it STAMPED the verdict of
 * whichever pull request's webhook was in hand onto every card that pull request
 * delivered (MOTIR-5470 replaces it with a fold over the card's whole delivery
 * set). Existing rows therefore carry three kinds of wrong answer: a stale
 * per-pull-request verdict on a card delivered by more than one; `null` on every
 * card a run delivered through its own session branch, which the old writer never
 * reached; and no `running` anywhere, because the pending arm wrote nothing.
 *
 * WHY A BACKFILL RATHER THAN WAITING FOR THE NEXT EVENT. For most of these cards
 * there is no next event. The checks have finished, so nothing further will
 * report; a card whose pull request merged last month will read its stale verdict
 * for ever. A badge and a filter are about to be built on this column, so each of
 * those rows is a card somebody looks for and does not find, or finds and does
 * not need.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE FOLD. Every card is handed to
 * `deliveryVerdict.recomputeWorkItemCiState` — the same function the live path
 * calls, under the same row lock. A backfill that folded the set in SQL would be
 * a second opinion about one card, and the two would drift on the first amendment
 * to either.
 *
 * IDEMPOTENT BY CONSTRUCTION: the recompute writes only when the value changed,
 * so a SECOND RUN OVER UNCHANGED DATA REPORTS `changed: 0` AND WRITES NOTHING.
 * That is a property of the recompute rather than of a shrinking candidate query,
 * which is what lets `--dry-run` predict a real run exactly — both fold the same
 * set through the same code, and only one of them writes. Each card commits in
 * its own transaction, so an interrupted run keeps its progress and the re-run
 * resumes from the rest.
 *
 * ARCHIVED CARDS ARE SKIPPED AND COUNTED. Archiving is a human saying this card
 * should not be worked; recomputing its badge is not this sweep's business, and
 * counting the skips keeps the abstention visible rather than inferable from a
 * smaller total.
 *
 * CROSS-TENANT BY DEFAULT — every workspace's rows have this gap.
 * `--workspace=<id>` narrows to one tenant.
 *
 * Usage:
 *   pnpm db:backfill:ci-state --dry-run              # rehearse: fold + print, write nothing
 *   pnpm db:backfill:ci-state                        # apply everywhere
 *   pnpm db:backfill:ci-state --workspace=<id>
 *
 * It runs against the LIVE tenant and needs only `DATABASE_URL` — unlike the
 * base-ref backfill it makes NO host calls, because every input it folds is
 * already recorded in the database:
 *
 *   DATABASE_URL='<core direct url>' pnpm db:backfill:ci-state --dry-run
 *
 * Against production it runs inside AWS, never from a laptop: Amazon RDS admits
 * only core's services, so it is `node /app/data/data-script.mjs backfill-ci-state` in a core
 * worker task (`docs/runbooks/production-data-scripts.md`).
 *
 * Do the dry run first, read the `from → to` counts, and only then apply.
 *
 * A LONG SWEEP REPORTS AS IT GOES (MOTIR-5765). Production holds ~1,957
 * candidates and the first run was cancelled by its job timeout having printed
 * nothing: the report was only ever written at the end. So a progress line is
 * printed every `CI_STATE_BACKFILL_PROGRESS_EVERY` cards, and SIGINT / SIGTERM —
 * what GitHub Actions sends on a timeout or a Cancel — stop the sweep between two
 * cards and print the PARTIAL report, marked INTERRUPTED, before exiting non-zero.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
// Run through `scripts/data-script-main.ts` (MOTIR-10465): the entry loads `.env`,
// composes `DATABASE_URL` in a Fargate task, and ends the pool after `main` answers.
import { workItemCiStateBackfillService } from '@/lib/services/workItemCiStateBackfillService';
import type {
  CiStateBackfillProgress,
  CiStateBackfillReport,
} from '@/lib/services/workItemCiStateBackfillService';

const TAG = '[backfill-ci-state]';

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
 *  `from → to` pair is unreadable, and "no checks" is a real verdict. */
function show(state: string | null): string {
  return state ?? 'none';
}

function printProgress(p: CiStateBackfillProgress): void {
  console.log(
    `${TAG} progress ${p.examined}/${p.total} — scanned ${p.scanned}, ` +
      `changed ${p.changed}, unchanged ${p.unchanged}, ` +
      `archived ${p.skippedArchived}, failed ${p.failed}`,
  );
}

function printReport(report: CiStateBackfillReport): void {
  const { dryRun } = report;

  // The per-transition breakdown, which is what an operator reads to decide
  // whether the sweep did what they expected: `failing → passing` on a hundred
  // cards is a repair, and `passing → failing` on a hundred is a reason to stop.
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

  if (args.dryRun) console.log(`${TAG} DRY RUN — folding only, nothing will be written.`);
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

  const report = await workItemCiStateBackfillService.backfillCiState({
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
    `${TAG} done — ${report.scanned} of ${report.total} card(s) with pull requests scanned, ` +
      `${report.changed.length} ${args.dryRun ? 'would change' : 'changed'}, ` +
      `${report.unchanged} already correct, ` +
      `${report.skippedArchived} archived (skipped), ` +
      `${report.failed.length} failed.` +
      (args.dryRun ? ' Re-run without --dry-run to apply.' : ''),
  );

  // A failed card is a NON-ZERO exit even though the sweep completed: an operator
  // piping this into a check must not read "some cards still carry a wrong
  // verdict" as success.
  if (report.failed.length > 0) {
    console.error(`${TAG} ${report.failed.length} card(s) failed — see above.`);
    return 1;
  }
  return 0;
}
