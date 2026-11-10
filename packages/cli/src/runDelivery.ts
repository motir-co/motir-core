import type { AgentHowToTest } from './agentRun.js';
import type { DispatchPrompt, MotirClient, WorkItemDelivery } from './client.js';
import type { DispatchTarget } from './dispatch.js';
import type { DispatchRunReporter } from './dispatchRunReporter.js';
import { execCommand, type CommandRunner } from './git.js';

// THE RUN DECLARES ITS OWN DELIVERY (MOTIR-10877).
//
// A card that opens its own pull request is finished when three things are true of it: the
// pull request is LINKED to the card (the link, not the title, is what lets the merge close it
// and what the CI watch reads), its HOW TO TEST is published, and it is at Implemented — in
// that order. The prompt asks the agent for the first two through `link_pull_request` and
// `publish_test_instructions`. An agent with no Motir tools cannot make either call: a hosted
// run's agent and an agent-instance run's agent hold no Motir token, and `/api/mcp` refuses a
// run token (`docs/decisions/agent-instance-run.md` §2). So the agent opened its pull request,
// the CLI moved the card to Implemented anyway, the CI watch found nothing to watch, and the
// card sat at Implemented linked to nothing — its merge would never close it.
//
// This module is the CLI making the calls the agent could not, with the run's own credential,
// after the agent exits and BEFORE anybody moves the card:
//
//   1. For each repository of the card, FIND its pull request: the URL the agent wrote into
//      `$MOTIR_AGENT_REPORT` as `pullRequests`, else the work branch's open pull request
//      (`gh pr view <branch>`, which in a hosted or agent-instance run goes through the run's
//      own `gh` shim and git credential). A pull request the card already delivers — an agent
//      WITH the tools linked it itself — counts as linked without a second call.
//   2. LINK it (`linkPullRequest`, the same v1 door the session close-out uses). Linking an
//      already-linked pull request is a no-op upsert, so nothing here tracks "have I linked".
//   3. PUBLISH the How to test the agent wrote as `howToTest`, with each repository's pushed
//      head — commits the CLI reads itself rather than trusts from the agent.
//
// It never moves a status and never throws: what it returns is what the caller decides on. A
// run whose work reached the remote but that could link NO pull request is not reported as a
// clean Implemented — `dispatch.ts`'s `pushedButUnlinked` says so on the leg — and neither is a
// multi-repository run that linked one repository's pull request while another repository's
// pushed work stayed unlinked (MOTIR-10888): the status sync completes the card on its LINKED
// pull requests alone, so the first merge would close it with the second repository's work
// still open.

/** A pull request the run found for one repository. */
interface FoundPullRequest {
  url: string;
  /** `owner/name`, from the URL. */
  repository: string;
  headRef: string;
  baseRef: string;
  /** The head commit, when it could be read. */
  headSha: string | null;
}

/** One repository's delivery, as the run left it. */
export interface DeliveredRepository {
  /** `owner/name` when known, else the repository's name in the payload. */
  repository: string;
  url: string;
  headSha: string | null;
}

/** A repository the run could link no pull request for — the leg's detail names its branch. */
export interface UndeliveredRepository {
  repository: string | null;
  branch: string | null;
  reason: string;
  /**
   * Whether work for the card is on this repository's remote (MOTIR-10888): its work branch
   * answers `git ls-remote`, a remote branch names the card, or a pull request was found. A
   * repository of the set the run pushed NOTHING to is not a missing delivery — runs routinely
   * find one listed repository needs nothing — so only a `pushed` one keeps a card that linked
   * another repository's pull request from Implemented.
   */
  pushed: boolean;
}

export interface RunDelivery {
  linked: DeliveredRepository[];
  unlinked: UndeliveredRepository[];
  /** What became of the agent's How to test: none written, published, or refused. */
  howToTest: 'none' | 'published' | 'refused';
}

export interface DeclareRunDeliveryInput {
  key: string;
  dispatch: Pick<DispatchPrompt, 'workBranch' | 'targetRepos' | 'targetRepoDefaultBranch'>;
  targets: Pick<DispatchTarget, 'targetRepo' | 'cwd' | 'repoPath'>[];
  /** Each repository's work branch, when they differ (a continue). */
  branches?: { repository: string | null; workBranch: string | null }[];
  /** What the agent wrote into its self-report. */
  pullRequests: readonly string[];
  howToTest: AgentHowToTest | null;
  client: Pick<MotirClient, 'getWorkItem' | 'linkPullRequest'>;
  reporter: Pick<DispatchRunReporter, 'event' | 'publishHowToTest'>;
  run?: CommandRunner;
}

/** `owner/name` of a GitHub pull-request URL, or null. */
export function repositoryOfPullRequestUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Whether an `owner/name` is the payload's repository `name` (case-insensitive). */
function sameRepository(ownerName: string, name: string | null): boolean {
  if (name === null) return false;
  const lower = ownerName.toLowerCase();
  const bare = name.toLowerCase();
  return lower === bare || lower.endsWith(`/${bare}`);
}

/** `gh pr view` of a URL or a branch, read in `cwd`. Null when `gh` cannot answer. */
function viewPullRequest(ref: string, cwd: string, run: CommandRunner): FoundPullRequest | null {
  const res = run(
    'gh',
    ['pr', 'view', ref, '--json', 'url,state,headRefName,headRefOid,baseRefName'],
    cwd,
  );
  if (res.exitCode !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const pr = parsed as Record<string, unknown>;
  const url = typeof pr.url === 'string' ? pr.url : null;
  const repository = url ? repositoryOfPullRequestUrl(url) : null;
  if (!url || !repository) return null;
  // A CLOSED pull request delivers nothing; a MERGED one already did.
  if (typeof pr.state === 'string' && pr.state.toUpperCase() === 'CLOSED') return null;
  if (typeof pr.headRefName !== 'string' || typeof pr.baseRefName !== 'string') return null;
  return {
    url,
    repository,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    headSha: typeof pr.headRefOid === 'string' && pr.headRefOid !== '' ? pr.headRefOid : null,
  };
}

/** The head of `origin/<branch>`, read from the remote, or null. */
function remoteHead(branch: string, cwd: string, run: CommandRunner): string | null {
  const res = run('git', ['ls-remote', 'origin', `refs/heads/${branch}`], cwd);
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/**
 * The remote branches naming `key` — where to look when the server named no work branch (one
 * older than MOTIR-6539). The same pattern the push check asks the remote with.
 */
function remoteBranchesNaming(key: string, cwd: string, run: CommandRunner): string[] {
  const res = run('git', ['ls-remote', '--heads', 'origin', `*${key}*`], cwd);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1] ?? '')
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
}

/** The card's own open deliveries, or none when they cannot be read. */
async function readDeliveries(
  client: DeclareRunDeliveryInput['client'],
  key: string,
): Promise<WorkItemDelivery[]> {
  try {
    const detail = await client.getWorkItem(key);
    return (detail.deliveries ?? []).filter((d) => d.state !== 'closed');
  } catch {
    return [];
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Link every pull request the run opened to `key`, then publish the agent's How to test.
 * See the file header. Never throws.
 */
export async function declareRunDelivery(input: DeclareRunDeliveryInput): Promise<RunDelivery> {
  const run = input.run ?? execCommand;
  const { key, dispatch, client, reporter } = input;
  // The card's own deliveries are read only when they can change the answer — no pull request
  // found, or a link refused — so a run that links what it found makes no extra read.
  let existing: WorkItemDelivery[] | null = null;
  const deliveries = async (): Promise<WorkItemDelivery[]> =>
    (existing ??= await readDeliveries(client, key));
  const reported = [...input.pullRequests];
  const linked: DeliveredRepository[] = [];
  const unlinked: UndeliveredRepository[] = [];
  const targets = input.targets.length > 0 ? input.targets : [];

  for (const [index, target] of targets.entries()) {
    const name = target.targetRepo;
    const cwd = target.repoPath ?? target.cwd;
    const branch =
      input.branches?.find((b) => b.repository === name)?.workBranch ?? dispatch.workBranch ?? null;
    const defaultBranch =
      dispatch.targetRepos?.find((r) => r.name === name)?.defaultBranch ??
      (index === 0 ? dispatch.targetRepoDefaultBranch : null) ??
      'main';

    // The agent's own word first; an unpinned card (no name) takes the first URL left.
    const urlAt = reported.findIndex((url) => {
      const repository = repositoryOfPullRequestUrl(url);
      return repository !== null && (name === null || sameRepository(repository, name));
    });
    const reportedUrl = urlAt >= 0 ? reported.splice(urlAt, 1)[0]! : null;

    let found: FoundPullRequest | null = null;
    // The branches it looked on, so a miss can name them.
    let searched: string[] = branch ? [branch] : [];
    if (reportedUrl) {
      found = viewPullRequest(reportedUrl, cwd, run) ?? {
        url: reportedUrl,
        repository: repositoryOfPullRequestUrl(reportedUrl)!,
        headRef: branch ?? '',
        baseRef: defaultBranch,
        headSha: branch ? remoteHead(branch, cwd, run) : null,
      };
    } else {
      // The work branch, else every remote branch naming the card.
      if (!branch) searched = remoteBranchesNaming(key, cwd, run);
      for (const candidate of searched) {
        found = viewPullRequest(candidate, cwd, run);
        if (found) break;
      }
    }

    if (!found) {
      const already = (await deliveries()).find((d) => sameRepository(d.repo, name));
      if (already) {
        // The agent linked it itself (it had the tools); nothing to call.
        linked.push({
          repository: already.repo,
          url: already.url,
          headSha: branch ? remoteHead(branch, cwd, run) : null,
        });
        reporter.event({
          kind: 'delivery_linked',
          workItemKey: key,
          data: { url: already.url, repository: already.repo, by: 'agent' },
        });
      } else {
        unlinked.push({
          repository: name,
          branch: branch ?? searched[0] ?? null,
          reason:
            searched.length > 0
              ? `no open pull request was found for ${searched.join(', ')}`
              : 'the run names no work branch to find a pull request on',
          // The named work branch is pushed when the remote answers for it; with no named
          // branch, the remote branches that name the card ARE the push.
          pushed: branch ? remoteHead(branch, cwd, run) !== null : searched.length > 0,
        });
      }
      continue;
    }

    if (!found.headRef) {
      unlinked.push({
        repository: found.repository,
        branch,
        reason: `the head branch of ${found.url} could not be read`,
        // A pull request exists, so its head was pushed.
        pushed: true,
      });
      continue;
    }
    try {
      await client.linkPullRequest({
        key,
        url: found.url,
        headRef: found.headRef,
        baseRef: found.baseRef,
      });
    } catch (err) {
      const url = found.url;
      const already = (await deliveries()).some((d) => d.url === url);
      if (!already) {
        unlinked.push({
          repository: found.repository,
          branch: found.headRef,
          reason: `linking ${found.url} was refused: ${messageOf(err)}`,
          pushed: true,
        });
        continue;
      }
    }
    linked.push({ repository: found.repository, url: found.url, headSha: found.headSha });
    reporter.event({
      kind: 'delivery_linked',
      workItemKey: key,
      data: { url: found.url, repository: found.repository, branch: found.headRef, by: 'run' },
    });
  }

  let howToTest: RunDelivery['howToTest'] = 'none';
  if (input.howToTest && reporter.publishHowToTest) {
    const repos = linked
      .filter((d): d is DeliveredRepository & { headSha: string } => d.headSha !== null)
      .map((d) => ({ repo: d.repository, commitSha: d.headSha }));
    const ok = await reporter.publishHowToTest(key, {
      bodyMd: input.howToTest.bodyMd,
      ...(input.howToTest.previewPath ? { previewPath: input.howToTest.previewPath } : {}),
      repos,
    });
    howToTest = ok ? 'published' : 'refused';
  }

  return { linked, unlinked, howToTest };
}
