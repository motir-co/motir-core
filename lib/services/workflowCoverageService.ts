import {
  judgeWorkflows,
  remoteActionKey,
  remoteActionsToRead,
  type ActionLookup,
  type JobJudgement,
} from '@/lib/ciFleet/jobCoverage';
import {
  parseActionMetadata,
  parseWorkflows,
  type ActionMetadata,
  type WorkflowSourceFile,
} from '@/lib/ciFleet/workflowJobs';
import {
  latestWorkflowCommit,
  readActionMetadata,
  readWorkflowSources,
} from '@/lib/github/orgInstallation';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';

// ONE PRIVATE REPOSITORY'S JOBS, JUDGED AT ITS HEAD (MOTIR-10290).
//
// The reads behind the image-coverage condition of the fleet readiness verdict,
// and behind the daily probe through it: the newest commit touching `.github`,
// the workflow files and local actions at that commit, and the `action.yml` of
// every remote action a fleet job uses (composite ones followed). Then the pure
// judge in `lib/ciFleet/jobCoverage.ts`. There is no snapshot to go stale: a
// workflow change is judged the next time anything asks.
//
// ⚠️ A READ GITHUB REFUSES IS `unreadable`, NEVER "nothing to judge" — the
// condition reads `unknown` and ON stays blocked. An action with no
// `action.yml` at its ref is NOT a refusal: it is `absent`, and the job using it
// is `unverified`.
//
// Cached in-process, by what makes a read immutable: workflow files by
// `owner/name@sha`; action metadata by `owner/repo/path@ref` for a while, since
// a tag can move. Neither cache can make a judgement stale for longer than its
// key allows — a new commit is a new key.

export type RepositoryCoverage =
  | {
      state: 'judged';
      /** The newest commit touching `.github`, or null when there is none. */
      headSha: string | null;
      jobs: JobJudgement[];
    }
  | {
      state: 'unreadable';
      /** Which read failed: the head commit, the files at it, or an action. */
      phase: 'head' | 'files' | 'actions';
      headSha: string | null;
      error: unknown;
    };

const SOURCES_CAP = 64;
const ACTIONS_CAP = 512;
const ACTION_TTL_MS = 30 * 60_000;
/** Rounds of remote-action reads — one per level of composite nesting. */
const MAX_ROUNDS = 5;

const sourcesCache = new Map<string, WorkflowSourceFile[]>();
const actionsCache = new Map<string, { value: ActionMetadata | 'absent'; at: number }>();

/** Tests only: forget every cached read. */
export function _resetWorkflowCoverageCache(): void {
  sourcesCache.clear();
  actionsCache.clear();
}

function remember<V>(cache: Map<string, V>, cap: number, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > cap) cache.delete(cache.keys().next().value as string);
}

async function sourcesAt(
  target: GithubOrgTarget,
  owner: string,
  name: string,
  sha: string,
): Promise<WorkflowSourceFile[]> {
  const key = `${owner}/${name}@${sha}`.toLowerCase();
  const cached = sourcesCache.get(key);
  if (cached) return cached;
  const files = await readWorkflowSources(target, owner, name, sha);
  remember(sourcesCache, SOURCES_CAP, key, files);
  return files;
}

/** One remote action's metadata, `absent` when it has no `action.yml`, or a
 *  parse failure read as `unknown` — a judge that cannot read a kind does not
 *  call it runnable. Throws on a refused read. */
async function actionAt(
  target: GithubOrgTarget,
  ref: { owner: string; repo: string; path: string; ref: string },
  key: string,
  now: number,
): Promise<ActionMetadata | 'absent'> {
  const cached = actionsCache.get(key);
  if (cached && now - cached.at < ACTION_TTL_MS) return cached.value;
  const text = await readActionMetadata(target, ref.owner, ref.repo, ref.path, ref.ref);
  let value: ActionMetadata | 'absent';
  if (text === null) value = 'absent';
  else {
    try {
      value = parseActionMetadata(text);
    } catch {
      value = { using: 'unknown', steps: [] };
    }
  }
  remember(actionsCache, ACTIONS_CAP, key, { value, at: now });
  return value;
}

export const workflowCoverageService = {
  /**
   * Judge every job of `owner/name` at its newest `.github` commit against the
   * runner image's `tools`. Never throws for a GitHub failure: it answers
   * `unreadable` with the phase that failed.
   */
  async repositoryCoverage(
    target: GithubOrgTarget,
    owner: string,
    name: string,
    tools: ReadonlySet<string>,
    now: () => number = Date.now,
  ): Promise<RepositoryCoverage> {
    let head: Awaited<ReturnType<typeof latestWorkflowCommit>>;
    try {
      head = await latestWorkflowCommit(target, owner, name);
    } catch (error) {
      return { state: 'unreadable', phase: 'head', headSha: null, error };
    }
    if (!head) return { state: 'judged', headSha: null, jobs: [] };

    let files: WorkflowSourceFile[];
    try {
      files = await sourcesAt(target, owner, name, head.sha);
    } catch (error) {
      return { state: 'unreadable', phase: 'files', headSha: head.sha, error };
    }
    const set = parseWorkflows(files);

    const read = new Map<string, ActionMetadata | 'absent'>();
    const lookup: ActionLookup = (key) => read.get(key);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const wanted = remoteActionsToRead(set, lookup);
      if (wanted.length === 0) break;
      try {
        for (const ref of wanted) {
          const key = remoteActionKey(ref);
          read.set(key, await actionAt(target, ref, key, now()));
        }
      } catch (error) {
        return { state: 'unreadable', phase: 'actions', headSha: head.sha, error };
      }
    }
    return { state: 'judged', headSha: head.sha, jobs: judgeWorkflows(set, tools, lookup) };
  },
};
