// The PUBLISH-WORKFLOW reads and the one write of the console's Fleet status page
// (MOTIR-10886): start an image's publish workflow, follow the run it started,
// say why a run failed, and the small history reads the page's gap lines need.
//
// A LEAF PRIMITIVE in the `lib/github/appAuth.ts` sense: services import it,
// routes never do. Every call names its repository; today that is only
// motir-core, where all three publish workflows live. The token is the caller's
// (`sourceRepoToken`): the reads also work anonymously on the public repository,
// the dispatch does not.
//
// No raw GitHub body escapes: a failure is a `PublishWorkflowError` with the
// status and GitHub's own one-line `message`, which the page shows verbatim on
// a failed dispatch.

import type { RepoRef } from '@/lib/github/repoCommitHistory';

const GITHUB_API = 'https://api.github.com';

/** `fetch` has no timeout of its own; a page read must not hang on GitHub. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The compare pages read before a commit count falls back to a date bound. */
const MAX_COMPARE_PAGES = 3;
/** The commit-list pages read for one path. */
const MAX_PATH_PAGES = 5;

/** A GitHub call that was refused or never reached GitHub. `status` is null on
 *  a transport failure. */
export class PublishWorkflowError extends Error {
  readonly code = 'PUBLISH_WORKFLOW_FAILED' as const;
  constructor(
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached (${detail}).`
        : `GitHub refused the call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'PublishWorkflowError';
  }
}

/** One workflow run, as the page follows it. */
export interface PublishWorkflowRun {
  id: number;
  runNumber: number | null;
  htmlUrl: string;
  /** GitHub's run status: `queued`, `in_progress`, `completed`, `waiting`, … */
  status: string;
  /** Set once `status` is `completed`: `success`, `failure`, `cancelled`, … */
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A tag ref, peeled to the commit it names. */
export interface TagCommit {
  name: string;
  commit: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A run id as GitHub issues them: a positive integer, written in plain digits. */
const RUN_ID = /^[1-9][0-9]{0,15}$/;

/**
 * The run-id path segment. ⚠️ A run id reaches this file from the page's poll,
 * i.e. from the browser, so it is held to the digits GitHub issues before it is
 * written into a URL — `lib/github/checkRuns.ts`'s rule: `Number.isInteger`
 * admits `1e21` (which stringifies to `1e+21`) and negatives. A value outside
 * it makes no request at all.
 */
function runSegment(runId: number): string {
  const segment = String(runId);
  if (!RUN_ID.test(segment)) {
    throw new PublishWorkflowError(null, 'the run id is not one GitHub could have issued');
  }
  return segment;
}

const repoPath = (repo: RepoRef) =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

async function call(
  method: 'GET' | 'POST',
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'motir',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PublishWorkflowError(null, err instanceof Error ? err.message : 'unknown');
  }
  let parsed: unknown = null;
  if (res.status !== 204) {
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const message = asRecord(parsed)?.['message'];
    throw new PublishWorkflowError(
      res.status,
      typeof message === 'string' ? message.slice(0, 300) : '',
    );
  }
  return { status: res.status, body: parsed };
}

function toRun(value: unknown): PublishWorkflowRun | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = row['id'];
  const htmlUrl = row['html_url'];
  const status = row['status'];
  if (typeof id !== 'number' || typeof htmlUrl !== 'string' || typeof status !== 'string') {
    return null;
  }
  const runNumber = row['run_number'];
  const conclusion = row['conclusion'];
  const createdAt = row['created_at'];
  const updatedAt = row['updated_at'];
  return {
    id,
    runNumber: typeof runNumber === 'number' ? runNumber : null,
    htmlUrl,
    status,
    conclusion: typeof conclusion === 'string' ? conclusion : null,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  };
}

async function listRuns(
  repo: RepoRef,
  workflow: string,
  query: string,
  token: string | null,
): Promise<PublishWorkflowRun[]> {
  const { status, body } = await call(
    'GET',
    `${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`,
    token,
  );
  const runs = asRecord(body)?.['workflow_runs'];
  if (!Array.isArray(runs)) throw new PublishWorkflowError(status, 'run list was not a list');
  return runs.map(toRun).filter((r): r is PublishWorkflowRun => r !== null);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const publishWorkflowsClient = {
  /**
   * Start `workflow` on `ref` with `inputs` and answer the run it started.
   * `return_run_details` makes GitHub answer the run id at once (200); an API
   * that still answers 204 is followed by a lookup of the newest
   * `workflow_dispatch` run created since the call.
   */
  async dispatch(
    repo: RepoRef,
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
    token: string,
  ): Promise<PublishWorkflowRun> {
    const startedAt = Date.now();
    const { body } = await call(
      'POST',
      `${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      token,
      { ref, inputs, return_run_details: true },
    );
    const details = asRecord(body);
    const runId = details?.['workflow_run_id'];
    if (typeof runId === 'number') {
      const read = await this.run(repo, runId, token).catch(() => null);
      if (read) return read;
      const htmlUrl = details?.['html_url'];
      const now = new Date().toISOString();
      return {
        id: runId,
        runNumber: null,
        htmlUrl:
          typeof htmlUrl === 'string'
            ? htmlUrl
            : `https://github.com/${repo.owner}/${repo.name}/actions/runs/${runId}`,
        status: 'queued',
        conclusion: null,
        createdAt: now,
        updatedAt: now,
      };
    }
    // The 204 form: the run appears in the list within a few seconds.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const runs = await listRuns(repo, workflow, 'event=workflow_dispatch&per_page=5', token);
      const found = runs.find((r) => Date.parse(r.createdAt) >= startedAt - 10_000);
      if (found) return found;
      await sleep(1_000 * (attempt + 1));
    }
    throw new PublishWorkflowError(null, 'the dispatched run did not appear in the run list');
  },

  /** One run, by id. */
  async run(repo: RepoRef, runId: number, token: string | null): Promise<PublishWorkflowRun> {
    const id = runSegment(runId);
    const { status, body } = await call('GET', `${repoPath(repo)}/actions/runs/${id}`, token);
    const run = toRun(body);
    if (!run) throw new PublishWorkflowError(status, 'the run carried no id or status');
    return run;
  },

  /** The runs of `workflow` GitHub has not finished, newest first. */
  async activeRuns(
    repo: RepoRef,
    workflow: string,
    token: string | null,
  ): Promise<PublishWorkflowRun[]> {
    const runs = await listRuns(repo, workflow, 'per_page=20', token);
    return runs.filter((r) => r.status !== 'completed');
  },

  /**
   * Why a finished run failed, in GitHub's own words: the failure annotations
   * of each failed job (the `::error::` lines a step wrote), else the job and
   * step that failed. Null when no job failed.
   */
  async failureDetail(repo: RepoRef, runId: number, token: string | null): Promise<string | null> {
    const id = runSegment(runId);
    const { body } = await call(
      'GET',
      `${repoPath(repo)}/actions/runs/${id}/jobs?filter=latest&per_page=100`,
      token,
    );
    const jobs = asRecord(body)?.['jobs'];
    if (!Array.isArray(jobs)) return null;
    const lines: string[] = [];
    for (const raw of jobs) {
      const job = asRecord(raw);
      const conclusion = job?.['conclusion'];
      if (conclusion !== 'failure' && conclusion !== 'timed_out' && conclusion !== 'cancelled') {
        continue;
      }
      const id = job?.['id'];
      const name = typeof job?.['name'] === 'string' ? (job['name'] as string) : 'a job';
      let annotated = false;
      if (typeof id === 'number') {
        const annotations = await call(
          'GET',
          `${repoPath(repo)}/check-runs/${id}/annotations?per_page=50`,
          token,
        ).catch(() => null);
        if (annotations && Array.isArray(annotations.body)) {
          for (const entry of annotations.body) {
            const a = asRecord(entry);
            if (a?.['annotation_level'] === 'failure' && typeof a['message'] === 'string') {
              lines.push(a['message']);
              annotated = true;
            }
          }
        }
      }
      if (!annotated) {
        const steps = Array.isArray(job?.['steps']) ? (job['steps'] as unknown[]) : [];
        const step = steps
          .map(asRecord)
          .find((s) => s?.['conclusion'] === 'failure' || s?.['conclusion'] === 'timed_out');
        const stepName = typeof step?.['name'] === 'string' ? (step['name'] as string) : null;
        lines.push(
          stepName
            ? `${name}: the step "${stepName}" ended ${String(conclusion)}`
            : `${name}: ${String(conclusion)}`,
        );
      }
    }
    if (lines.length === 0) return null;
    return [...new Set(lines)].join('\n').slice(0, 2000);
  },

  /**
   * How many commits between `base` and `head` touched `path`: the compare's
   * commits (`base...head`) that also appear in `path`'s history from `head`.
   * When the compare is longer than the pages read, the path history is bounded
   * by the base commit's date instead.
   */
  async countPathCommits(
    repo: RepoRef,
    base: string,
    head: string,
    path: string,
    token: string | null,
  ): Promise<number> {
    const between = new Set<string>();
    let total = 0;
    let since: string | null = null;
    for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
      const { status, body } = await call(
        'GET',
        `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
        token,
      );
      const compare = asRecord(body);
      const commits = compare?.['commits'];
      if (!Array.isArray(commits)) throw new PublishWorkflowError(status, 'compare had no commits');
      const totalCommits = compare?.['total_commits'];
      total = typeof totalCommits === 'number' ? totalCommits : commits.length;
      if (since === null) {
        const date = asRecord(
          asRecord(asRecord(compare?.['merge_base_commit'])?.['commit'])?.['committer'],
        )?.['date'];
        since = typeof date === 'string' ? date : '';
      }
      for (const c of commits) {
        const sha = asRecord(c)?.['sha'];
        if (typeof sha === 'string') between.add(sha);
      }
      if (commits.length < 100 || between.size >= total) break;
    }
    if (total === 0) return 0;
    const exact = between.size >= total;
    let count = 0;
    for (let page = 1; page <= MAX_PATH_PAGES; page += 1) {
      const query =
        `sha=${encodeURIComponent(head)}&path=${encodeURIComponent(path)}&per_page=100&page=${page}` +
        (since ? `&since=${encodeURIComponent(since)}` : '');
      const { status, body } = await call('GET', `${repoPath(repo)}/commits?${query}`, token);
      if (!Array.isArray(body))
        throw new PublishWorkflowError(status, 'commit list was not a list');
      for (const c of body) {
        const sha = asRecord(c)?.['sha'];
        if (typeof sha !== 'string' || sha === base) continue;
        if (!exact || between.has(sha)) count += 1;
      }
      if (body.length < 100) break;
    }
    return count;
  },

  /** Every tag whose name starts with `prefix`, peeled to its commit. */
  async tagsWithPrefix(repo: RepoRef, prefix: string, token: string | null): Promise<TagCommit[]> {
    const { status, body } = await call(
      'GET',
      `${repoPath(repo)}/git/matching-refs/tags/${encodeURIComponent(prefix)}`,
      token,
    );
    if (!Array.isArray(body)) throw new PublishWorkflowError(status, 'ref list was not a list');
    const tags: TagCommit[] = [];
    for (const raw of body) {
      const ref = asRecord(raw);
      const name = ref?.['ref'];
      const object = asRecord(ref?.['object']);
      const sha = object?.['sha'];
      if (typeof name !== 'string' || typeof sha !== 'string') continue;
      tags.push({
        name: name.replace(/^refs\/tags\//, ''),
        // An annotated tag names its tag object; `peel` resolves it on demand.
        commit: object?.['type'] === 'tag' ? `tag:${sha}` : sha,
      });
    }
    return tags;
  },

  /** The commit an annotated tag object names (`tag:<sha>` from `tagsWithPrefix`),
   *  or the commit itself. */
  async peel(repo: RepoRef, commit: string, token: string | null): Promise<string> {
    if (!commit.startsWith('tag:')) return commit;
    const { status, body } = await call(
      'GET',
      `${repoPath(repo)}/git/tags/${encodeURIComponent(commit.slice(4))}`,
      token,
    );
    const sha = asRecord(asRecord(body)?.['object'])?.['sha'];
    if (typeof sha !== 'string') throw new PublishWorkflowError(status, 'the tag named no object');
    return sha;
  },

  /** A commit's committer date. */
  async commitDate(repo: RepoRef, sha: string, token: string | null): Promise<string> {
    const { status, body } = await call(
      'GET',
      `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
      token,
    );
    const date = asRecord(asRecord(asRecord(body)?.['commit'])?.['committer'])?.['date'];
    if (typeof date !== 'string') throw new PublishWorkflowError(status, 'the commit had no date');
    return date;
  },

  /** Whether `path` exists in the tree at `ref`. */
  async pathExists(
    repo: RepoRef,
    path: string,
    ref: string,
    token: string | null,
  ): Promise<boolean> {
    try {
      await call(
        'GET',
        `${repoPath(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        token,
      );
      return true;
    } catch (err) {
      if (err instanceof PublishWorkflowError && err.status === 404) return false;
      throw err;
    }
  },
};
