/**
 * `pnpm db:backfill:pr-base-ref` — fill `github_pull_request.base_ref` on MERGED
 * mirror rows that predate the column, then RE-RUN the repository-set completion
 * gate for the work items those rows belong to (MOTIR-3034).
 *
 * THE DEFECT. `base_ref` shipped nullable and deliberately un-backfilled
 * (MOTIR-2729) — a row mirrored before the column existed does not know which
 * branch its merge landed on, and `classifyRepoDelivery` reads null as UNKNOWN
 * rather than guessing `main`. That rule is correct and this script does not
 * touch it. But the completion gate's only trigger is a change-request DELIVERY,
 * and for a repository whose work already merged, no further delivery is coming —
 * so an item held by one of these rows is held FOREVER, with no surface that can
 * repair it. MOTIR-2725, the story that built the gate, was held by it on the day
 * it shipped.
 *
 * THE TWO HALVES, BOTH RUN HERE. Filling the column alone leaves every already-
 * held card held, because a corrected row changes nothing until something re-runs
 * the decision; re-running the decision alone reads the same null and reaches the
 * same verdict. So this script fills the column and then hands every touched item
 * to `repoSetCompletionService.reevaluateItem`. `--no-reevaluate` splits them
 * when you want the writes reviewed before any status moves.
 *
 * ⚠️ IT NEVER WRITES A GUESS. A pull request the installation cannot read — a
 * deleted or transferred repository, a number that 404s — leaves the column NULL
 * and the repository UNKNOWN, and is COUNTED as `unanswerable` so the abstention
 * is visible rather than inferred from a smaller total.
 *
 * IDEMPOTENT BY CONSTRUCTION: the candidate query is `merged AND base_ref IS
 * NULL` and the write re-asserts `base_ref IS NULL`, so a filled row leaves the
 * candidate set and a SECOND RUN MAKES ZERO HOST CALLS AND ZERO WRITES. A
 * repository with no candidates never even mints a token. Each row commits in its
 * own transaction, so an interrupted run keeps its progress.
 *
 * CROSS-TENANT BY DEFAULT — every workspace whose mirror predates the column has
 * this gap. `--workspace=<id>` narrows to one tenant, `--repo=owner/name` to one
 * repository.
 *
 * Usage:
 *   pnpm db:backfill:pr-base-ref --dry-run              # rehearse: decide + print, write nothing
 *   pnpm db:backfill:pr-base-ref                        # apply + re-evaluate everywhere
 *   pnpm db:backfill:pr-base-ref --no-reevaluate        # fill the column only
 *   pnpm db:backfill:pr-base-ref --workspace=<id>
 *   pnpm db:backfill:pr-base-ref --repo=moooon-B-V/motir-core
 *
 * It runs against the LIVE tenant and needs BOTH halves of the credential:
 * `DATABASE_URL` for the target database AND the user-facing GitHub App
 * credentials the installation token is minted from (`GITHUB_APP_ID` +
 * `GITHUB_APP_PRIVATE_KEY` — the SAME App whose installation ids the
 * `github_installation` rows carry; a different App cannot mint for them). Both
 * App variables are Sensitive in Vercel, so `vercel env pull` returns them as
 * `[SENSITIVE]` and they must be supplied from the operator's own copy:
 *
 *   DATABASE_URL='<core direct url>' GITHUB_APP_ID='…' \
 *     GITHUB_APP_PRIVATE_KEY="$(cat app.pem)" pnpm db:backfill:pr-base-ref --dry-run
 *
 * Do the dry run first, read the per-repo counts, and only then apply.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { pullRequestBaseRefBackfillService } from '@/lib/services/pullRequestBaseRefBackfillService';
import type { PullRequestBaseRefBackfillReport } from '@/lib/services/pullRequestBaseRefBackfillService';

const TAG = '[backfill-pr-base-ref]';

interface Args {
  dryRun: boolean;
  reevaluate: boolean;
  workspaceId: string | undefined;
  repoRef: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let reevaluate = true;
  let workspaceId: string | undefined;
  let repoRef: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--no-reevaluate') reevaluate = false;
    else if (arg.startsWith('--workspace=')) workspaceId = arg.slice('--workspace='.length);
    else if (arg.startsWith('--repo=')) repoRef = arg.slice('--repo='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, reevaluate, workspaceId, repoRef };
}

function printReport(report: PullRequestBaseRefBackfillReport): void {
  const { dryRun } = report;
  if (report.repos.length === 0) {
    console.log(`${TAG} no GitHub-connected repository in scope.`);
  }
  for (const repo of report.repos) {
    if (repo.error) {
      console.error(`${TAG}   ${repo.repoRef} FAILED — ${repo.error}`);
    }
    console.log(
      `${TAG}   ${repo.repoRef} (workspace ${repo.workspaceId}): ` +
        `${repo.candidates} merged row(s) with no base, ` +
        `${dryRun ? 'would fill' : 'filled'} ${repo.filled}, ` +
        `${repo.unanswerable} unanswerable (left NULL — still UNKNOWN, never guessed), ` +
        `${repo.racedByDelivery} filled by a live delivery first.`,
    );
  }
  for (const repoRef of report.skippedNonGithub) {
    console.log(`${TAG}   ${repoRef} skipped — not a GitHub connection.`);
  }
  for (const verdict of report.reevaluated) {
    console.log(
      `${TAG}   re-evaluated ${verdict.workItemId}: ${verdict.outcome}` +
        (verdict.toStatus ? ` → ${verdict.toStatus}` : '') +
        (verdict.shortfall.outstanding.length > 0
          ? ` (still outstanding: ${verdict.shortfall.outstanding.join(', ')})`
          : '') +
        (verdict.shortfall.unknownBase.length > 0
          ? ` (still unknown: ${verdict.shortfall.unknownBase.join(', ')})`
          : ''),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) console.log(`${TAG} DRY RUN — deciding only, nothing will be written.`);
  console.log(
    `${TAG} scope: ${args.repoRef ?? 'every connected repo'}` +
      `${args.workspaceId ? ` in workspace ${args.workspaceId}` : ''}; ` +
      `re-evaluation ${args.reevaluate ? 'ON' : 'OFF'}.`,
  );

  const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs({
    dryRun: args.dryRun,
    reevaluate: args.reevaluate,
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.repoRef ? { repoRef: args.repoRef } : {}),
  });
  printReport(report);

  const filled = report.repos.reduce((sum, r) => sum + r.filled, 0);
  const unanswerable = report.repos.reduce((sum, r) => sum + r.unanswerable, 0);
  const completed = report.reevaluated.filter((v) => v.outcome === 'transitioned').length;
  const failed = report.repos.filter((r) => r.error).length;
  console.log(
    args.dryRun
      ? `${TAG} done — dry run, 0 rows written (${filled} would be, ${unanswerable} unanswerable). ` +
          `Re-run without --dry-run to apply.`
      : `${TAG} done — ${filled} row(s) filled, ${unanswerable} left UNKNOWN, ` +
          `${completed} item(s) completed by the re-evaluation.`,
  );
  // A failed repository is a NON-ZERO exit even though the sweep completed: an
  // operator piping this into a check must not read "some repos still hold their
  // items forever" as success.
  if (failed > 0) {
    console.error(`${TAG} ${failed} repository/repositories failed — see above.`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
