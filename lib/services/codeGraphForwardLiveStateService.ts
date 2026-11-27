import { getGitProvider } from '@/lib/git';
import { readPullRequest } from '@/lib/github/pullRequestRead';
import type { CodeGraphForwardData } from '@/lib/jobs/types';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE LIVE READ BEHIND A RE-SENT OPEN REPORT (MOTIR-12321) — what GitHub says about
// a pull request NOW, for `system.code-graph-forward` to check before it re-sends a
// `state: open` report it has been holding.
//
// ⚠️ WHY A HELD OPEN REPORT ASKS AGAIN. An open report answered `unknown_ref` waits
// for its head to be indexed (MOTIR-12299), and that wait can outlive the pull
// request: closed or merged before the head publishes, its close report answers
// `unknown_ref` too and settles on that first answer, writing nothing. When the head
// then publishes, the still-waiting open report is re-sent and RECORDED, and
// motir-codegraph holds an open row for a closed pull request. The delivery that
// enqueued the report is no longer the truth, so a re-send reads the pull request
// live — exactly as `codeGraphPrHeadIndex.ts` step `pr-head-v1` reads its head —
// and reports what the host says instead of what it said then.
//
// It is built on the one-time open-pull-request report's reads
// (`openPullRequestReportService.ts`): the repository row under `withSystemContext`
// (a forward is system-scoped and `github_repo`'s RLS answers a silent subset under
// any narrower context), the token minted through the seam with the repository's
// owner (which picks the App by provenance), and the `lib/github/` read leaf with
// the shared retry policy. The token is dropped inside this function and never
// returned, logged or put in an error.
//
// ⚠️ AN UNANSWERABLE READ THROWS. `readPullRequest` raises `PullRequestReadError`
// when the host cannot be reached or keeps throttling; the job defers on it as it
// does on an outage. A pull request the host answers is gone, or a repository no
// longer connected to the organisation, is a RESULT: there is nothing to record.

/** What the host says about the pull request a held open report names. */
export type CodeGraphForwardLiveState =
  /** Still open: re-send the report as it is. */
  | { kind: 'open' }
  /** Closed or merged since: report THAT, as GitHub reports it now. */
  | {
      kind: 'ended';
      state: 'closed' | 'merged';
      /** Exactly when `state` is `merged`. */
      mergedAt?: string;
      /** The pull request's `updated_at` now — the report's time. */
      reportedAt: string;
    }
  /** The host answered 404 / 410: the pull request (or its repository) is gone. */
  | { kind: 'gone' }
  /** The organisation no longer has this GitHub repository connected. */
  | { kind: 'not_connected' };

type PullRequestStateData = Extract<CodeGraphForwardData, { kind: 'pull_request_state' }>;

/** An ISO time GitHub wrote, kept as GitHub wrote it, or null when it does not parse. */
function readTime(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

export const codeGraphForwardLiveStateService = {
  /** Read the pull request `data` names, live. Throws only when the host cannot answer. */
  async read(data: PullRequestStateData): Promise<CodeGraphForwardLiveState> {
    const slash = data.repoRef.indexOf('/');
    const owner = data.repoRef.slice(0, slash);
    const name = data.repoRef.slice(slash + 1);
    if (slash < 1 || name === '') return { kind: 'not_connected' };

    const repo = await withSystemContext((tx) =>
      githubRepoRepository.findConnectedByOrganizationAndName(
        data.coreOrganizationId,
        owner,
        name,
        tx,
      ),
    );
    if (!repo || repo.installation.provider !== 'github') return { kind: 'not_connected' };

    const { token } = await getGitProvider('github').mintInstallationToken(
      repo.installation.installationId,
      { owner: repo.owner },
    );
    const read = await readPullRequest(token, repo.owner, repo.name, data.pullRequestNumber, {
      caller: 'codeGraphForward',
      installationId: repo.installation.installationId,
    });
    if (read.kind === 'gone') return { kind: 'gone' };

    const pr = read.pullRequest;
    if (pr['state'] === 'open') return { kind: 'open' };
    const ref = `${data.repoRef}#${String(data.pullRequestNumber)}`;
    const reportedAt = readTime(pr['updated_at']);
    if (pr['state'] !== 'closed' || !reportedAt) {
      throw new Error(`code-graph forward: ${ref} has no readable state or updated_at`);
    }
    if (pr['merged'] !== true) return { kind: 'ended', state: 'closed', reportedAt };
    // A merged report needs its merge time; a guessed one would read as a measurement.
    const mergedAt = readTime(pr['merged_at']);
    if (!mergedAt) throw new Error(`code-graph forward: ${ref} is merged with no merged_at`);
    return { kind: 'ended', state: 'merged', mergedAt, reportedAt };
  },
};
