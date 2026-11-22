/**
 * `pnpm db:first-index-pass` — hand EVERY connected repository to motir-codegraph
 * once (MOTIR-11885 · story MOTIR-11022).
 *
 * WHY. Until MOTIR-11883 a first index ran on the container fleet, and a
 * repository the fleet indexed has a succeeded `system.code-graph-index` row that
 * says so. The new service holds none of those graphs. The first-index gates now
 * count only rows the handoff wrote (`output.indexedBy: 'motir-codegraph'`), and
 * this command is the one-time push that does not wait for a bind, a reconcile or
 * a sweep: it enqueues one `system.code-graph-index` per connected repository that
 * is not archived, WHATEVER the ledger says, through the same chokepoint the
 * webhook uses.
 *
 * It ENQUEUES; it does not index. Watch the `system.code-graph-index` runs in the
 * job dashboard. A host the job cannot index is the job's verdict
 * (`provider_cannot_index`), not this command's.
 *
 * SAFE TO RE-RUN: every run is a full pass, so a second run enqueues every
 * repository again. The job and the service are idempotent per commit, so that
 * costs a run, not a wrong graph — but rehearse with `--dry-run` first.
 *
 * Usage:
 *   pnpm db:first-index-pass --dry-run              # list what would be enqueued; enqueue nothing
 *   pnpm db:first-index-pass                        # enqueue for every workspace
 *   pnpm db:first-index-pass --workspace=<id>       # scope to one workspace
 *
 * Against production it runs inside AWS as the data script `first-index-pass`
 * (`scripts/data-script-main.ts`, `docs/runbooks/production-data-scripts.md`), as
 * the application role — which is why its reads run under `withSystemContext`.
 */
import {
  codeGraphIndexService,
  type FirstIndexPassReport,
} from '@/lib/services/codeGraphIndexService';

const TAG = '[first-index-pass]';
const WORKSPACE_FLAG = '--workspace=';

export interface Args {
  dryRun: boolean;
  workspaceId: string | undefined;
}

export function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let workspaceId: string | undefined;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith(WORKSPACE_FLAG) && arg.length > WORKSPACE_FLAG.length) {
      workspaceId = arg.slice(WORKSPACE_FLAG.length);
    } else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, workspaceId };
}

/** Where the script writes — injectable so a test reads the lines it printed. */
export interface Out {
  log: (line: string) => void;
}

export function printReport(report: FirstIndexPassReport, out: Out): void {
  const verb = report.dryRun ? 'would enqueue' : 'enqueued';
  out.log(
    `${TAG} scanned ${report.scanned} connected repo(s): ${verb} ` +
      `${report.dryRun ? report.repos.length : report.enqueued}, skipped ${report.skipped.length}.`,
  );
  for (const repo of report.repos) {
    out.log(
      `${TAG}   ${verb} ${repo.repoRef} (@${repo.defaultBranch}, workspace ${repo.workspaceId})`,
    );
  }
  for (const skip of report.skipped) {
    out.log(`${TAG}   skipped ${skip.repoRef} (workspace ${skip.workspaceId}): ${skip.reason}`);
  }
}

/** The whole CLI over an argv: returns the exit code. A bad flag throws. */
export async function run(argv: readonly string[], opts: { out?: Out } = {}): Promise<number> {
  const out = opts.out ?? console;
  const args = parseArgs(argv);
  if (args.dryRun) out.log(`${TAG} DRY RUN — listing only, nothing will be enqueued.`);
  out.log(
    args.workspaceId
      ? `${TAG} scope: workspace ${args.workspaceId}.`
      : `${TAG} scope: every workspace with connected repos.`,
  );
  const report = await codeGraphIndexService.enqueueFirstIndexPass({
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    dryRun: args.dryRun,
  });
  printReport(report, out);
  out.log(
    args.dryRun
      ? `${TAG} done. Re-run without --dry-run to enqueue them.`
      : `${TAG} done — ${report.enqueued} index job(s) enqueued. Watch the ` +
          `'system.code-graph-index' runs; each repo is handed to motir-codegraph by its run.`,
  );
  return 0;
}

/** The data-script entry's `main`. */
export async function main(argv: readonly string[]): Promise<number> {
  return run(argv);
}
