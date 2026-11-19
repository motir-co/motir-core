import type { GithubInstallation, GithubRepo } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import { readPullRequestBaseRef } from '@/lib/github/pullRequestBase';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  repoSetCompletionService,
  type RepoSetReevaluationResult,
} from './repoSetCompletionService';

// `github_pull_request.base_ref` BACKFILL (MOTIR-3034) — the service behind
// `pnpm db:backfill:pr-base-ref`.
//
// THE PROBLEM. `base_ref` shipped nullable and deliberately un-backfilled
// (MOTIR-2729): a row mirrored before the column existed genuinely does not know
// which branch its merge landed on, and `classifyRepoDelivery` therefore reads it
// as UNKNOWN in both directions rather than guessing `main`. That per-decision
// rule is right and this sweep does not touch it. What it changes is the DATA:
// the provider still knows the answer, and one field on
// `GET /repos/{owner}/{name}/pulls/{number}` returns it.
//
// WHY THAT MATTERS BEYOND TIDINESS. The completion gate's only trigger is a
// change-request delivery, so a repository whose work already merged is never
// re-asked — an item held by one of these rows is held FOREVER. Filling the
// column is only half a repair; re-running the decision is the other half, which
// is why this sweep hands every item it touched to
// `repoSetCompletionService.reevaluateItem`. Neither half is useful alone: a
// corrected row changes nothing until something re-runs the gate, and a re-run
// against the same null reaches the same verdict.
//
// WHAT IT NEVER DOES.
//   * It never writes a GUESS. A pull request the host cannot answer for — a
//     deleted or transferred repository, a number that 404s — leaves the column
//     NULL and the repository UNKNOWN. That is the fail-closed state working, not
//     a failure of the sweep, and it is counted and reported rather than smoothed.
//   * It never touches a row that already has a `base_ref`. The candidate query
//     selects on `base_ref IS NULL` and the write re-asserts it, so a second run
//     makes ZERO host calls and ZERO writes — idempotent at the database rather
//     than by a comparison in this file.
//   * It never re-derives a work-item LINK, a title, or a state. Exactly one
//     column moves. (That is the difference from the historical-PR mirror sweep
//     beside it, which rewrites the whole content tuple and would also fill these
//     rows — at the cost of walking every repository's entire merged history and
//     re-resolving every link. See `lib/github/pullRequestBase.ts`.)

/** How the sweep is scoped. Both filters are optional; with neither, every
 *  GitHub-connected repo in the database is swept — the defect is cross-tenant,
 *  because every workspace whose mirror predates the column has it. */
export interface PullRequestBaseRefBackfillOptions {
  /** Decide + report, write nothing and re-evaluate nothing. */
  dryRun: boolean;
  /** Narrow to one workspace. */
  workspaceId?: string;
  /** Narrow to one repository, as `owner/name` (case-insensitive). */
  repoRef?: string;
  /** Re-run the completion gate for every item whose row this sweep filled.
   *  Defaults to true — the two halves are one repair (see the header). Set
   *  false to fill the column and decide the items in a separate, reviewable
   *  step. */
  reevaluate?: boolean;
}

/** One repository's outcome. */
export interface PullRequestBaseRefRepoReport {
  repoRef: string;
  workspaceId: string;
  /** Merged rows with a null `base_ref` — the candidates this repo offered. */
  candidates: number;
  /** Rows whose base the provider answered and this sweep wrote (or, on a dry
   *  run, would write). */
  filled: number;
  /** Rows the provider could not answer for. Left NULL, still UNKNOWN — never a
   *  guess. Counted because a silent skip and a deliberate abstention look
   *  identical in a log that does not distinguish them. */
  unanswerable: number;
  /** Rows a concurrent delivery filled between the candidate read and the write.
   *  Never an error: the live path's value is the better one. */
  racedByDelivery: number;
  /** Set when this repo failed; the sweep continues with the next one. */
  error?: string;
}

/** What one sweep decided and (unless dry-run) did. */
export interface PullRequestBaseRefBackfillReport {
  dryRun: boolean;
  repos: PullRequestBaseRefRepoReport[];
  /** `owner/name` of every non-GitHub connected repo the sweep skipped — a GitLab
   *  project's merge requests are not readable through this leaf, and silently
   *  omitting them would read as "there were none". */
  skippedNonGithub: string[];
  /** The verdict for every work item whose row this sweep filled, in the order
   *  they were re-evaluated. Empty on a dry run and when `reevaluate` is false. */
  reevaluated: RepoSetReevaluationResult[];
}

function emptyRepoReport(repo: GithubRepo): PullRequestBaseRefRepoReport {
  return {
    repoRef: `${repo.owner}/${repo.name}`,
    workspaceId: repo.workspaceId,
    candidates: 0,
    filled: 0,
    unanswerable: 0,
    racedByDelivery: 0,
  };
}

export const pullRequestBaseRefBackfillService = {
  /**
   * Fill `base_ref` on every MERGED mirror row that is missing one, then re-run
   * the completion gate for the work items those rows belong to.
   *
   * RESUMABLE RATHER THAN ALL-OR-NOTHING, in the two senses the historical sweep
   * established:
   *   * ONE TRANSACTION PER ROW, so a run killed partway keeps every row it
   *     already filled, and the (idempotent) re-run resumes from the remaining
   *     candidates — which by then are exactly the ones it has not done.
   *   * A repository that FAILS — a revoked installation, a rate limit that
   *     outlasted the retry budget — is recorded with its error and the sweep
   *     moves on. One broken connection does not cost the other repos' progress.
   */
  async backfillMissingBaseRefs(
    opts: PullRequestBaseRefBackfillOptions,
  ): Promise<PullRequestBaseRefBackfillReport> {
    // The repo set + its installations in ONE read, under system context: the
    // sweep is cross-tenant by default and `github_repo`'s RLS policy is
    // workspace-keyed, so there is no single workspace to bind. Both tables this
    // read touches carry a `system_admin` arm.
    const all = await withSystemContext((tx) =>
      githubRepoRepository.listWithInstallation(
        tx,
        opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
      ),
    );

    const wantedRef = opts.repoRef?.toLowerCase();
    const inScope = wantedRef
      ? all.filter((r) => `${r.owner}/${r.name}`.toLowerCase() === wantedRef)
      : all;

    const skippedNonGithub = inScope
      .filter((r) => r.provider !== 'github')
      .map((r) => `${r.owner}/${r.name}`);
    const repos = inScope.filter((r) => r.provider === 'github');

    const reports: PullRequestBaseRefRepoReport[] = [];
    // The PULL REQUESTS this sweep actually filled, deduplicated across the whole
    // run. The cards they deliver are resolved from them AFTERWARDS, in one read
    // (MOTIR-3721): a pull request delivers a SET of cards, so the ids cannot be
    // taken off the candidate row's own link column — that column names at most
    // one of them, and a sweep that re-evaluated one card of three would report
    // `filled: N` having repaired nothing (ADR §5).
    const touchedPullRequestIds = new Set<string>();

    for (const repo of repos) {
      reports.push(await sweepRepo(repo, opts.dryRun, touchedPullRequestIds));
    }

    // A work item can be delivered by rows in SEVERAL repositories, so the id set
    // is deduplicated by the read itself — re-evaluating one item twice would be
    // harmless but would report two verdicts for one decision.
    const touchedWorkItemIds =
      touchedPullRequestIds.size > 0
        ? await withSystemContext((tx) =>
            workItemDeliveryRepository.listWorkItemIdsByPullRequests(
              [...touchedPullRequestIds],
              tx,
            ),
          )
        : [];

    const reevaluated =
      !opts.dryRun && opts.reevaluate !== false && touchedWorkItemIds.length > 0
        ? await repoSetCompletionService.reevaluateItems(touchedWorkItemIds, {
            dryRun: false,
          })
        : [];

    return { dryRun: opts.dryRun, repos: reports, skippedNonGithub, reevaluated };
  },
};

async function sweepRepo(
  repo: GithubRepo & { installation: GithubInstallation },
  dryRun: boolean,
  touchedPullRequestIds: Set<string>,
): Promise<PullRequestBaseRefRepoReport> {
  const report = emptyRepoReport(repo);

  // The candidate read FIRST, so a repository with nothing to fix never mints a
  // token and never touches the host. That is what makes a second run free.
  const candidates = await withSystemContext((tx) =>
    githubPullRequestRepository.listMergedMissingBaseRefByRepo(repo.id, tx),
  );
  report.candidates = candidates.length;
  if (candidates.length === 0) return report;

  let token: string;
  try {
    // The installation token, minted through the seam — never persisted, and
    // scoped by GitHub to this installation's repos. `installation.installationId`
    // is the HOST's numeric id (the row's `id` is our cuid).
    //
    // `forRepo` is what picks the App by the repository's PROVENANCE (MOTIR-5843):
    // a hosted repository is on the provisioning App and on no other, so a mint
    // through the user-facing default cannot reach it — and the refusal is caught
    // below and reported as a per-repo error, which reads exactly like a repository
    // whose rows were all already backfilled.
    ({ token } = await getGitProvider('github').mintInstallationToken(
      repo.installation.installationId,
      { owner: repo.owner },
    ));
  } catch (err) {
    report.error = `could not mint an installation token: ${errorDetail(err)}`;
    return report;
  }

  try {
    for (const candidate of candidates) {
      const read = await readPullRequestBaseRef(token, repo.owner, repo.name, candidate.number, {
        caller: 'pullRequestBaseRefBackfill',
        installationId: repo.installation.installationId,
      });
      if (read.kind === 'unanswerable') {
        // The column stays NULL and the repository stays UNKNOWN. This is the
        // fail-closed doctrine holding, and the reason the count is reported.
        report.unanswerable += 1;
        continue;
      }

      if (dryRun) {
        report.filled += 1;
        continue;
      }

      const written = await withSystemContext((tx) =>
        githubPullRequestRepository.setBaseRefIfNull(candidate.id, read.baseRef, tx),
      );
      if (written === 0) {
        // A live delivery filled it between the candidate read and this write.
        // Its value came from the delivery payload, so it is at least as good;
        // nothing to do but say so.
        report.racedByDelivery += 1;
        continue;
      }
      report.filled += 1;
      // The PULL REQUEST, not a card id read off it (MOTIR-3721). Which cards
      // this merge could complete is a question for the delivery table, asked
      // once for the whole sweep.
      touchedPullRequestIds.add(candidate.id);
    }
  } catch (err) {
    // Every failure mode is recorded on the repo and the sweep moves on — the
    // typed read error already names the repo and the status, and anything else
    // (a database error mid-sweep) is reported verbatim rather than swallowed.
    report.error = errorDetail(err);
  }

  return report;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
