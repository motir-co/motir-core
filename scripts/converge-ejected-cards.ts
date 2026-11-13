/**
 * `pnpm db:converge:unlanded-cards` — put every card the OLD rules left holding a spent
 * approval where the FOURTH AMENDMENT now puts it (Story MOTIR-5799 · MOTIR-5809;
 * `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 9).
 *
 * WHY. One approval authorizes ONE merge or enqueue action. Until that shipped, a card
 * whose merge did not land kept its approval and was offered a button that reused it.
 * Those buttons are gone, so a card left over from the old rules would sit with nothing
 * to press and nothing to say.
 *
 * THE FIVE POPULATIONS:
 *
 *   A. `implemented` with a standing RETRYABLE or SETTING exit at a member's head
 *      → `in_review` with ONE fresh approve-to-merge gate.
 *   B. `implemented` with a standing CONFLICT — or, since the FIFTH AMENDMENT, a standing
 *      queue FAILURE → already where the new rules put it: COUNTED and left alone.
 *   C. `approved` with a standing NEUTRAL removal → the removal spent the approval,
 *      so the card is asked again.
 *   D. `approved` holding an open member with no outcome at all, under an approval
 *      decided more than ten minutes ago → a host refusal nobody recorded (the record
 *      is newer than the press). One is written with the backfill-only code
 *      `unrecorded`, classed RETRYABLE, and the card is asked again.
 *   E. `in_review` holding an AWAITING gate the OLD rule re-asked from a standing queue
 *      FAILURE (Story MOTIR-6587 · MOTIR-6595; §4 FIFTH AMENDMENT, point 4) → the gate
 *      is withdrawn with the cause `queue_failed` and the card is HELD at `implemented`,
 *      where `motir fix` claims it. A DECIDED gate is skipped `gate_decided`.
 *
 * Everything else is SKIPPED AND COUNTED by reason.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE MOVE OR THE RAISE. Each card goes through
 * `ejectedCardConvergenceService`, which calls `settleUnlandedOutcome` — the entry point
 * a live queue exit and a live host refusal both run.
 *
 * IDEMPOTENT: a converged A/C/D card is at `in_review` and a converged E card is held at
 * `implemented`, so a second apply converges 0.
 *
 * Usage:
 *   pnpm db:converge:unlanded-cards --dry-run    # rehearse: classify + print, write nothing
 *   pnpm db:converge:unlanded-cards              # apply
 *
 *   DATABASE_URL='<core direct url>' pnpm db:converge:unlanded-cards --dry-run
 *
 * Against production it runs inside AWS, never from a laptop: Amazon RDS admits
 * only core's services, so it is
 * `node /app/data/data-script.mjs converge-unlanded-cards` in a core worker task
 * (`docs/runbooks/production-data-scripts.md`).
 *
 * Do the dry run first, read the counts, and only then apply. Running it on production
 * is its own task (MOTIR-5810), after the release that carries the re-ask is live.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
// Run through `scripts/data-script-main.ts` (MOTIR-10465): the entry loads `.env`,
// composes `DATABASE_URL` in a Fargate task, and ends the pool after `main` answers.
import { ejectedCardConvergenceService } from '@/lib/services/ejectedCardConvergenceService';
import type { ConvergeReport } from '@/lib/services/ejectedCardConvergenceService';

const TAG = '[converge-unlanded-cards]';

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun };
}

function printReport(report: ConvergeReport): void {
  const verb = report.dryRun ? 'would converge' : 'converged';
  const withdrawn = new Set(report.withdrawnQueueFailed.map((card) => card.workItemId));
  for (const card of report.converged) {
    console.log(
      withdrawn.has(card.workItemId)
        ? `${TAG}   ${verb} ${card.identifier} (${card.workItemId}) → gate withdrawn queue_failed, held at implemented`
        : `${TAG}   ${verb} ${card.identifier} (${card.workItemId}) → in_review + ONE gate`,
    );
  }
  const byReason = new Map<string, string[]>();
  for (const skip of report.skipped) {
    byReason.set(skip.reason, [...(byReason.get(skip.reason) ?? []), skip.identifier]);
  }
  for (const [reason, keys] of byReason) {
    console.log(`${TAG}   skipped ${keys.length} — ${reason}: ${keys.join(', ')}`);
  }
  for (const failure of report.failed) {
    console.error(`${TAG}   ${failure.workItemId} FAILED — ${failure.error}`);
  }
  const skippedBy = (reason: string) => byReason.get(reason)?.length ?? 0;
  console.log(
    `${TAG} done — scanned ${report.scanned}, ${verb} ${report.converged.length} ` +
      `(of which queue failure withdrawn ${report.withdrawnQueueFailed.length}), ` +
      `skipped ${report.skipped.length} (can't land held ${skippedBy('cant_land_held')}, ` +
      `head moved ${skippedBy('head_moved')}, auto mode ${skippedBy('auto_mode')}, ` +
      `already in_review ${skippedBy('already_in_review')}, gate decided ${skippedBy('gate_decided')}, ` +
      `no approved gate ${skippedBy('no_approved_gate')}, nothing stranded ${skippedBy('nothing_stranded')}, ` +
      `too recent ${skippedBy('too_recent')}, other status ${skippedBy('other_status')}, ` +
      `archived ${skippedBy('archived')}), failed ${report.failed.length}.` +
      (report.dryRun ? ' Re-run without --dry-run to apply.' : ''),
  );
}

/** Runs the convergence on `argv`; answers the exit code (1 when a card failed). */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.dryRun) console.log(`${TAG} DRY RUN — classifying only, nothing will be written.`);
  const report = await ejectedCardConvergenceService.converge({ dryRun: args.dryRun });
  printReport(report);
  // A failed card is a NON-ZERO exit even though the sweep completed.
  return report.failed.length > 0 ? 1 : 0;
}
