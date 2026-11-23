/**
 * `pnpm codegraph:report-open-pull-requests` — report every connected GitHub
 * repository's open same-repository pull requests to motir-codegraph as OPEN, once,
 * through the code-graph forward (MOTIR-12057 · story MOTIR-11870).
 *
 * The webhook forwards every pull request opened, reopened or closed after the
 * forwarding deployed. A pull request already open before then is unknown to the
 * service until its next event, and its branch could be swept first. Run this ONCE
 * after the forwarding deploys to close that gap.
 *
 * RE-RUNNABLE: it keeps no state and writes no row of its own (each forward is a
 * job). A second run enqueues the same reports, and the service's newest-wins rule
 * answers them `stale`. Default-branch heads and unmapped repositories are answered
 * by the service and motir-ai as settled no-ops.
 *
 * Usage:
 *   pnpm codegraph:report-open-pull-requests --dry-run            # decide + print, enqueue nothing
 *   pnpm codegraph:report-open-pull-requests                      # every connected repository
 *   pnpm codegraph:report-open-pull-requests --workspace=<id>     # one tenant
 *   pnpm codegraph:report-open-pull-requests --repo=<owner/name>  # one repository
 *
 * Needs `DATABASE_URL` and the GitHub App credentials the installation tokens are
 * minted from (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, and the provisioning
 * App's for hosted repositories), exactly as `pnpm db:backfill:pull-requests`.
 *
 * Exits non-zero only on a usage error: a repository that failed is in the report,
 * and re-running it with `--repo` is the remedy.
 *
 * Against production it runs inside AWS as the data script
 * `report-open-pull-requests` (`scripts/data-script-main.ts`,
 * `docs/runbooks/production-data-scripts.md`), as the application role — which is
 * why its read runs under `withSystemContext`.
 */
import {
  openPullRequestReportService,
  type OpenPullRequestReport,
  type OpenPullRequestReportOptions,
} from '@/lib/services/openPullRequestReportService';

const TAG = '[report-open-pull-requests]';
const REPO_REF = /^[^/\s]+\/[^/\s]+$/;

/** The command line as report options. A bad flag throws: the entry answers 1. */
export function parseArgs(argv: readonly string[]): OpenPullRequestReportOptions {
  const opts: OpenPullRequestReportOptions = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--workspace=') && arg.length > '--workspace='.length) {
      opts.workspaceId = arg.slice('--workspace='.length);
    } else if (arg.startsWith('--repo=') && REPO_REF.test(arg.slice('--repo='.length))) {
      opts.repoRef = arg.slice('--repo='.length);
    } else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return opts;
}

/** Where the script writes — injectable so a test reads the lines it printed. */
export interface Out {
  log: (line: string) => void;
}

/** The report as the lines the operator reads: each repository, the skips, the totals. */
export function printReport(report: OpenPullRequestReport, out: Out): void {
  const verb = report.dryRun ? 'would forward' : 'forwarded';
  if (report.repos.length === 0) out.log(`${TAG} no GitHub-connected repository in scope.`);
  for (const r of report.repos) {
    out.log(
      `${TAG}   ${r.repoRef} (organization ${r.organizationId}): pages=${r.pages} ` +
        `truncated=${r.truncated} scanned=${r.scanned} ${verb}=${r.forwarded} ` +
        `skippedForks=${r.skippedForks} skippedMalformed=${r.skippedMalformed} ` +
        `error=${r.error ?? 'none'}`,
    );
  }
  for (const ref of report.skippedArchived) out.log(`${TAG}   skipped ${ref}: archived`);
  for (const ref of report.skippedNonGithub) out.log(`${TAG}   skipped ${ref}: not GitHub`);
  const t = report.totals;
  out.log(
    `${TAG} totals: repos=${t.repos} failed=${t.failed} truncated=${t.truncated} ` +
      `scanned=${t.scanned} ${verb}=${t.forwarded} skippedForks=${t.skippedForks} ` +
      `skippedMalformed=${t.skippedMalformed} skippedArchived=${report.skippedArchived.length} ` +
      `skippedNonGithub=${report.skippedNonGithub.length}`,
  );
}

/**
 * The whole CLI over an argv: returns the exit code. A repository's failure is in
 * the report, never the exit code; only a usage error (a thrown bad flag) is non-zero.
 */
export async function run(argv: readonly string[], opts: { out?: Out } = {}): Promise<number> {
  const out = opts.out ?? console;
  const args = parseArgs(argv);
  if (args.dryRun) out.log(`${TAG} DRY RUN — deciding only, nothing will be enqueued.`);
  out.log(
    `${TAG} scope: ${args.repoRef ?? 'every connected repository'}` +
      `${args.workspaceId ? ` in workspace ${args.workspaceId}` : ''}.`,
  );
  printReport(await openPullRequestReportService.reportOpenPullRequests(args), out);
  return 0;
}

/** The data-script entry's `main`. */
export async function main(argv: readonly string[]): Promise<number> {
  return run(argv);
}
