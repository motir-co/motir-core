/**
 * `pnpm db:retire:hosted-mirrors` — take every Motir-hosted repository NO project
 * holds out of its organisation's connected set (bug MOTIR-12192).
 *
 * WHY. A repository Motir hosts belongs to the project it was created for, but
 * until MOTIR-12192 removing it from that project left its `github_repo` mirror
 * connected to the organisation: listed in Settings › Organisation › Git, counted
 * by the first-index pass, and kept in the inventory motir-ai's code-graph
 * reconcile subtracts from, so its mapping and graph were never removed. The
 * removal now retires the mirror; this script retires the ones left behind before
 * it did (on 2026-11-24 in production, `motir-ratelimit-a/motir-envcheck-sandbox`
 * and `motir-projects/motir`), and any a failed post-commit retire leaves later.
 *
 * WHAT IT TOUCHES: only a mirror whose owner is one Motir hosts under
 * (`GITHUB_FALLBACK_ORG` plus every fleet account's org) AND that no
 * `project_repository` row holds. An organisation's own repository and a hosted
 * repository a project still uses are never candidates. The mirror is stamped
 * `retired_at`, not deleted, so its pull requests stay readable on their work
 * items. Run it where `GITHUB_FALLBACK_ORG` is set as the app has it — with the
 * variable unset and no fleet accounts, Motir hosts nothing and it retires nothing.
 *
 * SAFE TO RE-RUN: a retired mirror is no longer a candidate, so a second run
 * retires nothing. Rehearse with `--dry-run` first.
 *
 * Usage:
 *   pnpm db:retire:hosted-mirrors --dry-run   # list what would be retired; write nothing
 *   pnpm db:retire:hosted-mirrors             # retire them
 *
 * Against production it runs inside AWS as the data script `retire-hosted-mirrors`
 * (`scripts/data-script-main.ts`, `docs/runbooks/production-data-scripts.md`), as
 * the application role — which is why its reads and writes run under
 * `withSystemContext`.
 */
import {
  hostedMirrorRetirementService,
  type HostedMirrorSweepReport,
} from '@/lib/services/hostedMirrorRetirementService';

const TAG = '[retire-hosted-mirrors]';

export interface Args {
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun };
}

/** Where the script writes — injectable so a test reads the lines it printed. */
export interface Out {
  log: (line: string) => void;
}

export function printReport(report: HostedMirrorSweepReport, out: Out): void {
  const verb = report.dryRun ? 'would retire' : 'retired';
  out.log(
    `${TAG} scanned ${report.scanned} connected repo(s) no project holds: ` +
      `${verb} ${report.retired.length} Motir-hosted mirror(s).`,
  );
  for (const mirror of report.retired) {
    out.log(
      `${TAG}   ${verb} ${mirror.repoRef} (github_repo ${mirror.id}, ` +
        `organisation ${mirror.organizationId}, workspace ${mirror.workspaceId})`,
    );
  }
}

/** The whole CLI over an argv: returns the exit code. A bad flag throws. */
export async function run(argv: readonly string[], opts: { out?: Out } = {}): Promise<number> {
  const out = opts.out ?? console;
  const args = parseArgs(argv);
  if (args.dryRun) out.log(`${TAG} DRY RUN — listing only, nothing will be written.`);
  const report = await hostedMirrorRetirementService.sweep({ dryRun: args.dryRun });
  printReport(report, out);
  out.log(
    args.dryRun
      ? `${TAG} done. Re-run without --dry-run to retire them.`
      : `${TAG} done — ${report.retired.length} mirror(s) retired. motir-ai's code-graph ` +
          `reconcile removes their mappings and graphs on its next pass.`,
  );
  return 0;
}

/** The data-script entry's `main`. */
export async function main(argv: readonly string[]): Promise<number> {
  return run(argv);
}
