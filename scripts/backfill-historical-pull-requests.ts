/**
 * `pnpm db:backfill:pull-requests` — mirror HISTORICAL merged pull requests into
 * `github_pull_request`, so work items that shipped before the GitHub App was
 * installed can carry implementation provenance (MOTIR-1965).
 *
 * The PR mirror (MOTIR-891) is fed purely by webhook deliveries, so a repository
 * holds rows only for PRs that changed state AFTER the App was installed on it.
 * On the live MOTIR tenant that leaves ~1100 done `coding_agent` items with no
 * linked PR and no session branch, and `classifyImplementationSource` therefore
 * abstains — correctly, on the evidence it has. This script supplies the missing
 * evidence rather than loosening the rule: it re-reads each connected repo's
 * MERGED pull requests off GitHub with an installation token, resolves each to a
 * work item through the status sync's OWN resolver, and writes the row the
 * webhook would have written.
 *
 * THEN RUN `pnpm db:backfill:provenance` (dry run first, as always). It is
 * idempotent and null-guarded, so it stamps only the newly-evidenced rows and
 * touches nothing already stamped. No change to MOTIR-1758's decision table is
 * needed or made.
 *
 * ⚠️ MERGED PRs ONLY. `classifyImplementationSource` stamps `byok` on
 * `hasLinkedPr`, which is `deliveries.length > 0` — it does NOT read the
 * `merged` column. Mirroring closed-unmerged PRs would therefore stamp `byok` on
 * items whose only PR was abandoned. Filtering at the source is the one option
 * that keeps every stamp true (see `lib/github/historicalPullRequests.ts`).
 *
 * IDEMPOTENT + RESUMABLE: a row that already says what the sweep would write is
 * left alone (not re-upserted — that would churn `updated_at`), so a second
 * consecutive run writes ZERO. Each page commits in its own transaction and a
 * failing repository is reported and stepped over, so an interrupted run keeps
 * its progress and a re-run continues from there. `--repo=owner/name` re-runs
 * one repository.
 *
 * CROSS-TENANT BY DEFAULT — every workspace whose repos predate its own App
 * install has this gap. `--workspace=<id>` narrows the sweep to one tenant.
 *
 * Usage:
 *   pnpm db:backfill:pull-requests --dry-run                 # rehearse: decide + print, write nothing
 *   pnpm db:backfill:pull-requests                           # apply everywhere
 *   pnpm db:backfill:pull-requests --workspace=<id>          # one tenant
 *   pnpm db:backfill:pull-requests --repo=moooon-B-V/motir-core
 *
 * It runs against the LIVE tenant and needs BOTH halves of the credential:
 * `DATABASE_URL` for the target database AND the user-facing GitHub App
 * credentials the token is minted from (`GITHUB_APP_ID` +
 * `GITHUB_APP_PRIVATE_KEY` — the SAME App whose installation ids the
 * `github_installation` rows carry; a different App cannot mint for them). Both
 * App variables are Sensitive in Vercel, so `vercel env pull` returns them as
 * `[SENSITIVE]` and they must be supplied from the operator's own copy:
 *
 *   DATABASE_URL='<core direct url>' GITHUB_APP_ID='…' \
 *     GITHUB_APP_PRIVATE_KEY="$(cat app.pem)" pnpm db:backfill:pull-requests --dry-run
 *
 * Do the dry run first, read the per-repo counts, and only then apply.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { historicalPullRequestBackfillService } from '@/lib/services/historicalPullRequestBackfillService';
import type { HistoricalPrBackfillReport } from '@/lib/services/historicalPullRequestBackfillService';

const TAG = '[backfill-pull-requests]';

interface Args {
  dryRun: boolean;
  workspaceId: string | undefined;
  repoRef: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let workspaceId: string | undefined;
  let repoRef: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--workspace=')) workspaceId = arg.slice('--workspace='.length);
    else if (arg.startsWith('--repo=')) repoRef = arg.slice('--repo='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, workspaceId, repoRef };
}

function printReport(report: HistoricalPrBackfillReport): void {
  const { dryRun } = report;
  if (report.repos.length === 0) {
    console.log(`${TAG} no GitHub-connected repository in scope.`);
  }
  for (const repo of report.repos) {
    if (repo.error) {
      console.error(`${TAG}   ${repo.repoRef} FAILED — ${repo.error}`);
    }
    console.log(
      `${TAG}   ${repo.repoRef} (workspace ${repo.workspaceId}, ${repo.pages} page(s)): ` +
        `${repo.scanned} closed PR(s) scanned, ` +
        `${repo.unattributed} mirrored unattributed, ` +
        `${dryRun ? 'would write' : 'wrote'} ${repo.written} row(s), ` +
        `${repo.unchanged} already current, ${repo.skippedLinked} existing link(s) preserved.`,
    );
    if (repo.truncated) {
      console.error(
        `${TAG}   ⚠️ ${repo.repoRef} was TRUNCATED at the page bound — its history was NOT ` +
          `fully read. Re-run with --repo=${repo.repoRef} after raising MAX_PULL_REQUEST_PAGES.`,
      );
    }
  }
  for (const repoRef of report.skippedNonGithub) {
    console.log(`${TAG}   ${repoRef} skipped — not a GitHub connection.`);
  }
  console.log(
    `${TAG} merged PRs only — a closed-unmerged PR is NOT evidence its item shipped, ` +
      `and 'hasLinkedPr' does not read the merged column.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) console.log(`${TAG} DRY RUN — deciding only, nothing will be written.`);
  console.log(
    `${TAG} scope: ${args.repoRef ?? 'every connected repo'}` +
      `${args.workspaceId ? ` in workspace ${args.workspaceId}` : ''}.`,
  );

  const report = await historicalPullRequestBackfillService.backfillMergedPullRequests({
    dryRun: args.dryRun,
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.repoRef ? { repoRef: args.repoRef } : {}),
  });
  printReport(report);

  const written = report.repos.reduce((sum, r) => sum + r.written, 0);
  const failed = report.repos.filter((r) => r.error).length;
  console.log(
    args.dryRun
      ? `${TAG} done — dry run, 0 rows written (${written} would be). ` +
          `Re-run without --dry-run to apply, then 'pnpm db:backfill:provenance --dry-run'.`
      : `${TAG} done — ${written} row(s) written. ` +
          `Next: 'pnpm db:backfill:provenance --dry-run', then apply.`,
  );
  // A failed repository is a NON-ZERO exit even though the sweep completed: an
  // operator piping this into a check must not read "some repos are missing
  // their history" as success.
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
