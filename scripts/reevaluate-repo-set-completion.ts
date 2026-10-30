/**
 * `pnpm db:reevaluate:repo-set` — re-run the repository-SET completion gate for
 * one or more work items, WITHOUT a change-request delivery (MOTIR-3034).
 *
 * WHY IT EXISTS. `changeRequestStatusSync` is the gate's only caller and it runs
 * on a delivery, so the decision is re-asked only when a pull request in the
 * item's set changes state. Three situations leave an item held with no such
 * event ever coming again:
 *
 *   1. A merge that ALREADY HAPPENED, mirrored before `base_ref` existed — the
 *      null base reads as UNKNOWN and holds the item forever. (Run
 *      `pnpm db:backfill:pr-base-ref` first; it fills the column AND calls this
 *      same service for every row it filled. This script is for the items it did
 *      not touch, or for a re-check afterwards.)
 *   2. An item's REPOSITORY SET was edited after its pull requests merged — a
 *      repository removed because the work never shipped there.
 *   3. A repository's DEFAULT BRANCH was renamed, so a merge that did reach the
 *      trunk now compares equal where it previously did not.
 *
 * WHAT IT DOES NOT DO. It does not relax the gate. It asks the SAME question, of
 * the same shared rule (`lib/workItems/repoDelivery.ts`), through the same write
 * authority (`workItemsService.updateStatus`) — only at a different moment. An
 * item whose set is EMPTY is ABSTAINED on, exactly as a delivery abstains, so
 * this can never bulk-complete unpinned cards; an item with an OPEN linked change
 * request is held, which is stricter than the delivery path (which excludes the
 * row it is deciding, because that one has just closed).
 *
 * Usage:
 *   pnpm db:reevaluate:repo-set --item=<workItemId> [--item=<workItemId> …]
 *   pnpm db:reevaluate:repo-set --item=<workItemId> --dry-run
 *
 * `--item` takes the work item's internal id (a cuid) — the value the backfill
 * report prints, and the `id` on the item's API payload. It is repeatable.
 *
 * Needs `DATABASE_URL` for the target database. Unlike the base-ref backfill it
 * calls no provider API, so it needs no GitHub App credential:
 *
 *   DATABASE_URL='<neon non-pooling url>' pnpm db:reevaluate:repo-set --item=<id> --dry-run
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { repoSetCompletionService } from '@/lib/services/repoSetCompletionService';

const TAG = '[reevaluate-repo-set]';

interface Args {
  dryRun: boolean;
  workItemIds: string[];
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  const workItemIds: string[] = [];

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--item=')) workItemIds.push(arg.slice('--item='.length));
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  if (workItemIds.length === 0)
    throw new Error(`${TAG} nothing to do — pass at least one --item=<workItemId>`);
  return { dryRun, workItemIds };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) console.log(`${TAG} DRY RUN — deciding only, no status will move.`);
  console.log(`${TAG} re-evaluating ${args.workItemIds.length} item(s).`);

  const verdicts = await repoSetCompletionService.reevaluateItems(args.workItemIds, {
    dryRun: args.dryRun,
  });

  for (const v of verdicts) {
    const detail = [
      v.toStatus ? `→ ${v.toStatus}` : '',
      v.shortfall.outstanding.length > 0
        ? `outstanding: ${v.shortfall.outstanding.join(', ')}`
        : '',
      v.shortfall.unknownBase.length > 0
        ? `no recorded base: ${v.shortfall.unknownBase.join(', ')}`
        : '',
      v.deliveryShortfall && v.deliveryShortfall.strandedBase.length > 0
        ? `merged off the trunk: ${v.deliveryShortfall.strandedBase.join(', ')}`
        : '',
      v.deliveryShortfall && v.deliveryShortfall.unknownBase.length > 0
        ? `no recorded base: ${v.deliveryShortfall.unknownBase.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`${TAG}   ${v.workItemId}: ${v.outcome}${detail ? ` — ${detail}` : ''}`);
  }

  const completed = verdicts.filter((v) => v.outcome === 'transitioned').length;
  const stillHeld = verdicts.filter((v) => v.outcome.startsWith('held_')).length;
  console.log(
    `${TAG} done — ${args.dryRun ? `${completed} would complete` : `${completed} completed`}, ` +
      `${stillHeld} still held.`,
  );
  // An item still held by `unknownBase` is the case the base-ref backfill exists
  // for, and saying so here is cheaper than the operator re-deriving it.
  if (verdicts.some((v) => v.shortfall.unknownBase.length > 0)) {
    console.log(
      `${TAG} some repositories have a merged change request with NO recorded base — ` +
        `run 'pnpm db:backfill:pr-base-ref' to read it back from the provider.`,
    );
  }
}

main()
  .catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
