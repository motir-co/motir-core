import type { GithubInstallation, GithubRepo } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import { repoRefOf } from '@/lib/github/indexEnqueue';
import { listOpenPullRequests } from '@/lib/github/openPullRequests';
import { enqueueCodeGraphForward } from '@/lib/jobs/codeGraphForward';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE ONE-TIME OPEN-PULL-REQUEST REPORT (MOTIR-12057 · story MOTIR-11870) — the
// service behind `pnpm codegraph:report-open-pull-requests`.
//
// The webhook forward (`githubCodeGraphForwardService`) reaches motir-codegraph for
// every pull request opened, reopened or closed AFTER it deployed. A pull request
// already open before then would be learned only at its next event, and the
// service could sweep its branch first. This report closes that gap once: for each
// connected GitHub repository it lists the open pull requests through the
// repository's own installation token and enqueues ONE `pull_request_state` forward
// (`state: 'open'`) per same-repository head.
//
// It is built step for step on `historicalPullRequestBackfillService`: one
// cross-tenant read under `withSystemContext` (`github_repo`'s RLS answers a silent
// subset under any narrower context), the token minted through the seam with the
// repository's owner (which picks the App by provenance), a `lib/github/` read leaf
// with the shared retry policy, and a failing repository recorded on its own report
// while the run moves on.
//
// ⚠️ IT KEEPS NO STATE AND WRITES NO ROW OF ITS OWN. Each forward it enqueues is a
// `job_queue` row; nothing else is written. Running it again enqueues the same
// reports, and the service's newest-wins rule answers them `stale` (or `recorded`
// with no change). Whether a head is the default branch, and whether the repository
// is mapped, are the service's and motir-ai's calls, answered as settled no-ops.

/** How the report is scoped. With no filter, every connected GitHub repository. */
export interface OpenPullRequestReportOptions {
  /** Decide and report, enqueue nothing. */
  dryRun: boolean;
  /** Narrow to one workspace. */
  workspaceId?: string;
  /** Narrow to one repository, as `owner/name` (case-insensitive). */
  repoRef?: string;
}

/** One repository's outcome. */
export interface OpenPullRequestRepoReport {
  repoRef: string;
  organizationId: string;
  /** Pages fetched. */
  pages: number;
  /** Whether the page bound was hit: the open set was NOT fully read. */
  truncated: boolean;
  /** Open pull requests listed. */
  scanned: number;
  /** Forwards enqueued (on a dry run, that WOULD be enqueued). */
  forwarded: number;
  /** Heads in another repository, or in a deleted fork. */
  skippedForks: number;
  /** Same-repository rows missing a number, a head ref or a parseable `updated_at`. */
  skippedMalformed: number;
  /** Set when this repository failed; the run continues with the next one. */
  error?: string;
}

/** What one run decided and (unless dry-run) enqueued. */
export interface OpenPullRequestReport {
  dryRun: boolean;
  repos: OpenPullRequestRepoReport[];
  /** `owner/name` of every archived row skipped: an archived repository takes no
   *  new pull request, and its open ones cannot change. */
  skippedArchived: string[];
  /** `owner/name` of every non-GitHub row skipped: this leaf reads GitHub only. */
  skippedNonGithub: string[];
  totals: {
    repos: number;
    failed: number;
    truncated: number;
    scanned: number;
    forwarded: number;
    skippedForks: number;
    skippedMalformed: number;
  };
}

type RepoWithInstallation = GithubRepo & { installation: GithubInstallation };

export const openPullRequestReportService = {
  /** Report every in-scope repository's open same-repository pull requests as open. */
  async reportOpenPullRequests(opts: OpenPullRequestReportOptions): Promise<OpenPullRequestReport> {
    const all = await withSystemContext((tx) =>
      githubRepoRepository.listWithInstallation(
        tx,
        opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
      ),
    );

    const wanted = opts.repoRef?.toLowerCase();
    const inScope = wanted ? all.filter((r) => repoRefOf(r).toLowerCase() === wanted) : all;

    const skippedNonGithub: string[] = [];
    const skippedArchived: string[] = [];
    const repos: RepoWithInstallation[] = [];
    for (const row of inScope) {
      if (row.provider !== 'github') skippedNonGithub.push(repoRefOf(row));
      else if (row.archived) skippedArchived.push(repoRefOf(row));
      else repos.push(row);
    }

    const reports: OpenPullRequestRepoReport[] = [];
    for (const repo of repos) reports.push(await reportRepo(repo, opts.dryRun));

    const sum = (pick: (r: OpenPullRequestRepoReport) => number) =>
      reports.reduce((total, r) => total + pick(r), 0);
    return {
      dryRun: opts.dryRun,
      repos: reports,
      skippedArchived,
      skippedNonGithub,
      totals: {
        repos: reports.length,
        failed: reports.filter((r) => r.error !== undefined).length,
        truncated: reports.filter((r) => r.truncated).length,
        scanned: sum((r) => r.scanned),
        forwarded: sum((r) => r.forwarded),
        skippedForks: sum((r) => r.skippedForks),
        skippedMalformed: sum((r) => r.skippedMalformed),
      },
    };
  },
};

async function reportRepo(
  repo: RepoWithInstallation,
  dryRun: boolean,
): Promise<OpenPullRequestRepoReport> {
  const repoRef = repoRefOf(repo);
  const report: OpenPullRequestRepoReport = {
    repoRef,
    organizationId: repo.organizationId,
    pages: 0,
    truncated: false,
    scanned: 0,
    forwarded: 0,
    skippedForks: 0,
    skippedMalformed: 0,
  };

  let token: string;
  try {
    // `owner` picks the App by the repository's provenance (MOTIR-5843): a hosted
    // repository is on the provisioning App only. A revoked or uninstalled
    // installation fails here and is reported on this repository.
    ({ token } = await getGitProvider('github').mintInstallationToken(
      repo.installation.installationId,
      { owner: repo.owner },
    ));
  } catch (err) {
    report.error = `could not mint an installation token: ${errorDetail(err)}`;
    return report;
  }

  try {
    for await (const page of listOpenPullRequests(token, repo.owner, repo.name, repo.repoId, {
      caller: 'openPullRequestReport',
      installationId: repo.installation.installationId,
    })) {
      report.pages += 1;
      report.scanned += page.scanned;
      report.skippedForks += page.forks;
      report.skippedMalformed += page.malformed;
      if (page.truncated) report.truncated = true;
      for (const pr of page.reports) {
        report.forwarded += 1;
        if (dryRun) continue;
        // Never throws into this loop: the door logs and swallows its own failures.
        await enqueueCodeGraphForward({
          kind: 'pull_request_state',
          coreOrganizationId: repo.organizationId,
          repoRef,
          ref: pr.headRef,
          pullRequestNumber: pr.number,
          state: 'open',
          reportedAt: pr.updatedAt,
        });
      }
    }
  } catch (err) {
    // The typed read error already names the repository and the status.
    report.error = errorDetail(err);
  }
  return report;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
