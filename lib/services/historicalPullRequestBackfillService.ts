import type { GithubInstallation, GithubRepo, Prisma } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import {
  listMergedPullRequests,
  type HistoricalPullRequest,
} from '@/lib/github/historicalPullRequests';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// Historical pull-request MIRROR backfill (MOTIR-1965) — the service behind
// `pnpm db:backfill:pull-requests`.
//
// THE PROBLEM. The PR mirror shipped at MOTIR-891 (7.10.3) and is fed purely by
// webhook deliveries, so a repository holds `github_pull_request` rows only for
// PRs that changed state AFTER the GitHub App was installed on it. Everything
// merged before that instant left no trace in the database. On the live MOTIR
// tenant that is ~1100 done, `coding_agent` work items with no linked PR and no
// session branch: `classifyImplementationSource` sees no evidence and abstains,
// which is the CORRECT reading of the data it has. This sweep changes the data,
// not the reading — it re-reads the merged PRs back off the host and writes the
// rows the webhook would have written had it been listening.
//
// WHAT MAKES A BACKFILLED ROW INDISTINGUISHABLE FROM A LIVE ONE (the card's
// load-bearing criterion). Three things, all structural rather than careful:
//   1. The listing normalizes GitHub's `pull_request` object into the SAME
//      `NormalizedChangeRequest` the webhook parser produces — same fields, same
//      endpoint object.
//   2. The work-item link is whatever the row ALREADY carries, which is what the
//      sync does too (MOTIR-3674). Until then both called `resolveChangeRequestWorkItem`,
//      the head-ref / title parse, exported for this caller rather than
//      re-implemented; that resolver is gone and neither path infers a link now.
//   3. The write goes through `githubPullRequestRepository.upsert` — the same
//      repository call, with the same column tuple, under the same row lock the
//      sync takes.
// The integration suite asserts it by DIFFING the columns of a row this sweep
// wrote against one the webhook wrote for the same PR, rather than by eye.
//
// ⚠️ WHAT IT NO LONGER DOES — ATTRIBUTE (MOTIR-3674, option A of that card).
// This sweep used to link each mirrored row to the work item whose key appeared
// in the pull request's head ref or title. A historical pull request CANNOT have
// had `link_pull_request` called on it — it was opened before Motir saw the
// repository — so there is no explicit path to fall back to here, and retiring
// the parse does not degrade the attribution, it REMOVES it. That is the whole
// choice, and it is deliberate: the sweep keeps doing the part that is fact (the
// pull request existed, on this repository, with this head ref, merged at this
// time) and stops doing the part that is a guess. A row it writes carries NO
// delivery and shows up on the ledger and the Development surface attached to no
// card, until somebody links it.
//
// A row that ALREADY carries a link keeps it, untouched — the same grandfathering
// the sync applies, for the same reason: a stored link is a link, and this card
// retires the inference rather than the history it produced.
//
// WHAT IT DOES NOT DO. It writes no work-item provenance, and — since MOTIR-3674
// removed the attribution pass — it no longer feeds any either. `hasLinkedPr` is
// the provenance classifier's evidence and it reads the DELIVERY set
// (MOTIR-3757); a row this sweep writes carries none, so `pnpm
// db:backfill:provenance` sees exactly what it saw before the sweep ran. That is
// the honest reading of MOTIR-3674's choice rather than a regression: the sweep
// mirrors pull requests, and only an explicit `link_pull_request` says which card
// one delivers. It also never transitions a status — the mirror row is evidence,
// not an event, and replaying six weeks of merges through the status sync would
// rewrite the history of every card it touched.

/** How the sweep is scoped. Both filters are optional; with neither, every
 *  GitHub-connected repo in the database is swept (the defect is cross-tenant —
 *  any workspace whose repos predate its own App install has it). */
export interface HistoricalPrBackfillOptions {
  /** Decide + report, write nothing. */
  dryRun: boolean;
  /** Narrow to one workspace. */
  workspaceId?: string;
  /** Narrow to one repository, as `owner/name` (case-insensitive) — the resume
   *  lever when a long sweep failed partway on a specific repo. */
  repoRef?: string;
}

/** One repository's outcome. Every count is per the card's required report. */
export interface HistoricalPrRepoReport {
  repoRef: string;
  workspaceId: string;
  /** Closed PRs read off the host (merged and abandoned alike). */
  scanned: number;
  /** Merged PRs mirrored with NO work item — every row this sweep writes fresh,
   *  since MOTIR-3674 removed the attribution pass. Still mirrored with a null
   *  link, exactly as a live delivery for an unlinked pull request does. */
  unattributed: number;
  /** Rows written (or, on a dry run, that WOULD be written). */
  written: number;
  /** Merged PRs whose row already matched the target shape — the idempotence
   *  counter. A second consecutive run has `written: 0` and everything here. */
  unchanged: number;
  /** Merged PRs skipped because the row already carries a STORED link — set by
   *  `link_pull_request` / `mark_integrated`, or historically by the retired
   *  parse. The sweep never overwrites one (MOTIR-3674's grandfathering). */
  skippedLinked: number;
  /** Pages fetched, so a long run's cost is visible. */
  pages: number;
  /** Whether the page bound was hit — the repo's history was NOT fully read. */
  truncated: boolean;
  /** Set when this repo failed; the sweep continues with the next one. */
  error?: string;
}

/** What one sweep decided and (unless dry-run) did. */
export interface HistoricalPrBackfillReport {
  dryRun: boolean;
  repos: HistoricalPrRepoReport[];
  /** `owner/name` of every non-GitHub connected repo the sweep skipped — a
   *  GitLab project's merge requests are not readable through this leaf, and
   *  silently omitting them would read as "there were none". */
  skippedNonGithub: string[];
}

/** The mirror row this sweep intends for one merged PR — the exact input shape
 *  `githubPullRequestRepository.upsert` takes, so "does the stored row already
 *  match?" is a field-by-field comparison with nothing left over. */
interface TargetRow {
  provider: string;
  repoId: string;
  number: number;
  state: string;
  merged: boolean;
  headRef: string;
  /** The branch the change request targeted (MOTIR-2729) — the completion gate's
   *  satisfied side reads it off the row, so a backfilled row that omitted it
   *  would be indistinguishable from a pre-column row and read as UNKNOWN. */
  baseRef: string;
  title: string | null;
  /** NOT ASSERTED by this sweep (MOTIR-5002), and the type requires it to say so.
   *  Every row here is MERGED, where draft-ness decides nothing — `merged`
   *  answers the lifecycle on its first arm, before the draft guard is reached —
   *  and the sole reader of the column skips merged rows outright. Leaving it
   *  unwritten also keeps `rowMatches` honest: a sweep that asserted `false` would
   *  rewrite every historical row once, purely to fill a column nothing here
   *  reads, and `updated_at` is what the Development surface orders by. */
  draft: undefined;
  /** NOT ASSERTED either (MOTIR-7005), for `draft`'s reason: a merged row's head
   *  decides nothing, and asserting it would rewrite every historical row once. */
  headSha: undefined;
  /** NOT ASSERTED either (MOTIR-10340): the author columns are not backfilled, and a
   *  merged row's author decides nothing the review state reads. */
  authorGithubUserId: undefined;
  authorLogin: undefined;
}

function emptyRepoReport(repo: GithubRepo): HistoricalPrRepoReport {
  return {
    repoRef: `${repo.owner}/${repo.name}`,
    workspaceId: repo.workspaceId,
    scanned: 0,
    unattributed: 0,
    written: 0,
    unchanged: 0,
    skippedLinked: 0,
    pages: 0,
    truncated: false,
  };
}

export const historicalPullRequestBackfillService = {
  /**
   * Mirror every connected GitHub repository's MERGED pull requests into
   * `github_pull_request`.
   *
   * RESUMABLE RATHER THAN ALL-OR-NOTHING, in two senses the card asks for:
   *   * Each PAGE commits in its own transaction, so a run killed at page 40
   *     keeps 39 pages of rows. The sweep is idempotent, so re-running resumes
   *     (already-correct rows count as `unchanged` and are not rewritten).
   *   * A repository that FAILS — a revoked installation, a deleted repo, a rate
   *     limit that outlasted the retry budget — is recorded with its error and
   *     the sweep moves to the next repository. One broken connection does not
   *     cost the other repos' progress.
   */
  async backfillMergedPullRequests(
    opts: HistoricalPrBackfillOptions,
  ): Promise<HistoricalPrBackfillReport> {
    // The repo set + its installations in ONE read, under system context: the
    // sweep is cross-tenant by default and `github_repo`'s RLS policy is
    // workspace-keyed, so there is no single workspace to bind (the same reason
    // the MOTIR-1961 first-index sweep reads this way).
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

    const reports: HistoricalPrRepoReport[] = [];
    for (const repo of repos) {
      reports.push(await sweepRepo(repo, opts.dryRun));
    }

    return { dryRun: opts.dryRun, repos: reports, skippedNonGithub };
  },
};

async function sweepRepo(
  repo: GithubRepo & { installation: GithubInstallation },
  dryRun: boolean,
): Promise<HistoricalPrRepoReport> {
  const report = emptyRepoReport(repo);

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
    // that had nothing to backfill.
    ({ token } = await getGitProvider('github').mintInstallationToken(
      repo.installation.installationId,
      { owner: repo.owner },
    ));
  } catch (err) {
    report.error = `could not mint an installation token: ${errorDetail(err)}`;
    return report;
  }

  try {
    for await (const page of listMergedPullRequests(token, repo.owner, repo.name, repo.repoId)) {
      report.scanned += page.scanned;
      report.pages += 1;
      if (page.truncated) report.truncated = true;
      // ONE TRANSACTION PER PULL REQUEST, not per page — for two reasons that
      // both bite only at real scale:
      //   * `applyOne` takes a `FOR UPDATE` lock on the mirror row. Batching a
      //     page would hold 100 of those to the end of the page, blocking any
      //     live webhook delivery for the same repo behind a backfill.
      //   * Prisma's interactive transactions carry a 5-second budget. A page's
      //     ~400 round-trips to a remote database exceeds it, so a page-sized
      //     transaction would abort in production exactly where it cannot be
      //     rehearsed — while a per-PR one is four queries.
      // It is also the finer resumability boundary: every PR that lands, stays.
      for (const pr of page.merged) {
        await withSystemContext(async (tx) => {
          // ⚠️ BIND THE TENANT FIRST (MOTIR-2880). `github_pull_request` reads on
          // the system flag, so the lock / read / upsert in `applyOne` are fine —
          // but the work-item read behind its attribution pass did not have such an
          // arm, so under `motir_app` EVERY historical PR mirrored a null link,
          // silently. That pass is gone (MOTIR-3674) and `applyOne` no longer reads
          // `work_item` at all, so the bind is no longer load-bearing HERE — it is
          // kept because it costs one statement and the next reader of this block
          // should not have to re-derive which tables it may touch.
          //
          // The repo row carries the tenancy (MOTIR-1931), and it is already
          // resolved here — the loop is inside the per-repo pass — so there is
          // nothing to discover and the bind goes at the top of the block.
          await bindWorkspaceContext(tx, repo.workspaceId);
          return applyOne(tx, repo, pr, dryRun, report);
        });
      }
    }
  } catch (err) {
    // Every failure mode is recorded on the repo and the sweep moves on — the
    // typed read error already names the repo and the status, and anything else
    // (a database error mid-page) is reported verbatim rather than swallowed.
    report.error = errorDetail(err);
  }

  return report;
}

/**
 * Decide and (unless dry-run) write ONE merged PR's mirror row.
 *
 * Mirrors `syncChangeRequestStatus`'s resolve phase step for step — the row
 * lock, the stored-link stickiness, the same upsert input — because a divergence
 * in ANY of them is exactly what would make a backfilled row distinguishable
 * from a live one. Since MOTIR-3674 neither path resolves a work item from text,
 * so there is no shared resolver left to keep in step: there is nothing to
 * resolve.
 */
async function applyOne(
  tx: Prisma.TransactionClient,
  repo: GithubRepo & { installation: GithubInstallation },
  pr: HistoricalPullRequest,
  dryRun: boolean,
  report: HistoricalPrRepoReport,
): Promise<void> {
  const cr = pr.changeRequest;

  // Lock before the read-derived write (the same lock the sync takes): whether
  // this sweep writes at all is decided from `existing` — the sticky-link return
  // below and `rowMatches` — so a webhook delivery landing between the read and
  // the write would otherwise be clobbered by a row derived from a stale read.
  // Skipped on a dry run, which writes nothing to serialize against.
  if (!dryRun) await githubPullRequestRepository.lockByRepoAndNumber(repo.id, cr.number, tx);
  const existing = await githubPullRequestRepository.findByRepoAndNumber(repo.id, cr.number, tx);

  // A STORED link is sticky, however it was made (MOTIR-3674's grandfathering).
  // The condition RE-POINTS with the storage (MOTIR-3757): it read
  // `existing.workItemId != null` while the association was a column on this row,
  // and that column is gone, so it asks the table the association moved to. The
  // question is unchanged — *does this pull request already deliver a card?* —
  // and so is the answer for every row, because the EXPAND migration
  // (20260827094500) backfilled one delivery per non-null link and every writer
  // since has written both.
  //
  // ⚠️ AND THE GUARD IS STILL LOAD-BEARING, though what it protects has changed
  // twice now. It could once clobber a LINK (the column MOTIR-3757 dropped), then
  // `linked_manually` (which `target` set to `false` unconditionally until
  // MOTIR-4894 stopped writing it). What is left is the whole mirror row: this
  // sweep's facts come from the historical REST read, and an already-delivering
  // pull request is one the WEBHOOK is maintaining, so re-writing its `state` /
  // `merged` / `title` from a bulk scan is the sweep speaking over the
  // authoritative source. It is also what makes `skippedLinked` mean anything.
  if (existing) {
    const deliveries = await workItemDeliveryRepository.listByPullRequest(existing.id, tx);
    if (deliveries.length > 0) {
      report.skippedLinked += 1;
      return;
    }
  }

  // No attribution pass. Every row this sweep writes carries a null link.
  report.unattributed += 1;

  const target: TargetRow = {
    // `installation.provider`, NOT `repo.provider` — the sync stamps the row from
    // the INSTALLATION, and matching it is part of being indistinguishable.
    // 'github' either way here (non-GitHub repos never reach this path), but the
    // rule is to mirror the sync's source, not to re-derive an equal value.
    provider: repo.installation.provider,
    repoId: repo.id,
    number: cr.number,
    state: cr.state,
    merged: cr.merged,
    headRef: cr.headRef,
    baseRef: cr.baseRef,
    title: cr.title,
    // See `TargetRow.draft`: merged rows only, where the flag decides nothing.
    draft: undefined,
    headSha: undefined,
    authorGithubUserId: undefined,
    authorLogin: undefined,
  };

  if (existing && rowMatches(existing, target)) {
    report.unchanged += 1;
    return;
  }

  report.written += 1;
  if (dryRun) return;
  await githubPullRequestRepository.upsert(target, tx);
}

/**
 * Whether the stored row ALREADY says what this sweep would write.
 *
 * This is what makes "a second run writes zero" true rather than merely
 * harmless. A blind re-upsert would write the same values and still bump
 * `updated_at` on every row — which the Development surface orders by, and which
 * the board's Done-column age window reads — so re-running the sweep would churn
 * the mirror's ordering for no gain. Every column the upsert sets is compared,
 * with ONE stated exception below; nothing else is (`id`, `repoId` and the
 * timestamps are identity, not content).
 *
 * ⚠️ NO LINK IS COMPARED, and its absence is a deletion rather than an oversight
 * (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md` §0 row S5). The
 * comparison used to read `existing.workItemId === target.workItemId`, and
 * `applyOne`'s sticky-link early return is what made that provably
 * `null === null`: a row carrying a link RETURNS before reaching here. So the
 * clause could never distinguish two rows — it was a read of the column that
 * decided nothing.
 *
 * The column itself went with MOTIR-3757, and the early return OUTLIVES it: it is
 * a WRITE-path guard rather than a reader of a set, and what it protects is the
 * mirror row of a pull request the webhook is already maintaining. (It protected
 * `linked_manually` in between; MOTIR-4894 stopped this sweep writing that field,
 * so the comparison below no longer names it and a row differing only in it is
 * `unchanged` — correct, since nothing decides on it any more.)
 *
 * ⚠️ NOR IS `draft` COMPARED, and that follows from the rule rather than joining
 * the exceptions (MOTIR-5002). This sweep passes `draft: undefined` — it does not
 * SET the column — so "every column the upsert sets" reaches it not at all. Had it
 * asserted `false` instead, this function would owe a clause, and the first
 * post-migration sweep would have rewritten every historical row to fill a column
 * no reader of a merged row consults.
 */
function rowMatches(
  existing: {
    provider: string;
    state: string;
    merged: boolean;
    headRef: string;
    baseRef: string | null;
    title: string | null;
  },
  target: TargetRow,
): boolean {
  return (
    existing.provider === target.provider &&
    existing.state === target.state &&
    existing.merged === target.merged &&
    existing.headRef === target.headRef &&
    // A row mirrored BEFORE `base_ref` existed carries null and does not match —
    // which is correct: the sweep should rewrite it precisely to fill that hole,
    // and counting it `unchanged` would leave the completion gate reading UNKNOWN
    // for a merge this sweep can prove landed on the trunk.
    existing.baseRef === target.baseRef &&
    existing.title === target.title
  );
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
