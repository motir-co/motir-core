// Node-only GitHub MERGE boundary mock for E2E (Story MOTIR-4909 · MOTIR-5572).
//
// *Approve and merge* merges each pull request SERVER-side: the press reaches
// `pullRequestMergeService.approveMergeGate`, which calls the GitHub provider's
// `mergeChangeRequest` (`lib/git/providers/github.ts`), which `fetch`es api.github.com
// through `githubMergeFetch`. None of that leaves the Next process for the browser, so
// Playwright's `page.route` cannot see it — this seam stands in for GitHub the SAME way
// `test-github-repos-mock` does: an undici intercept on the ONE shared `MockAgent`,
// installed by instrumentation.ts behind `E2E_TEST_GITHUB_MERGE=1`, dormant everywhere
// else. The REAL `mergeChangeRequest` runs against it, so the lane exercises the shipped
// classification of every answer rather than a stub of it.
//
// What it intercepts (every call `mergeChangeRequest` makes for a pull request):
//   - GET  /repos/{owner}/{name}                        → the allowed merge methods
//   - GET  /repos/{owner}/{name}/pulls/{number}         → the pull request, and its re-read
//   - GET  /repos/{owner}/{name}/rules/branches/{base}  → does the base require a merge queue?
//   - PUT  /repos/{owner}/{name}/pulls/{number}/merge   → the merge, or the host's refusal
//   - POST /graphql (`enqueuePullRequest`)              → the queue entry
//   - GET  /repos/{owner}/{name}/pulls/{number}/files   → the pull request's paths (empty, or
//                                                         the head's files the control names)
//   - GET  /repos/{owner}/{name}/contents/{path}?ref=   → a file's raw text (MOTIR-5681),
//                                                         at that ref when the control
//                                                         keys it by ref (MOTIR-7866)
//   - GET  /repos/{owner}/{name}/commits/{ref}          → the commit a ref names, as the SHA
//                                                         media type: {@link e2eRefSha} of the
//                                                         ref, which the contents read below
//                                                         maps back to it (MOTIR-10122)
//   - GET  /repos/{owner}/{name}/commits/{sha}/check-runs
//                                                       → a commit's check runs, ONLY for a
//                                                         commit the control names (MOTIR-6851)
//   - GET  /repos/{owner}/{name}/collaborators/{login}/permission
//                                                       → whether a REVIEWER can write (MOTIR-5595)
//   - POST /app/installations/{id}/access_tokens        → ONLY when E2E_TEST_GITHUB_REPOS is
//                                                         off (that seam already answers it,
//                                                         and journals it for its own spec)
//
// ⚠️ SCOPED TO THE REPOSITORIES THE CONTROL NAMES, AND REGISTERED BEFORE THE REPOS SEAM.
// The acceptance lane runs every `acceptance*.spec.ts` in ONE server with both GitHub seams
// on, and both answer `GET /repos/{owner}/{name}`. Undici tries intercepts in REGISTRATION
// order and falls through a path predicate that answers false, so this seam claims a path
// only for a repository its control file lists (`repositories`, or the repository half of a
// `pullRequests` key) and every other repository reaches the repos seam untouched. An
// unscoped intercept here would shadow the repository-set journey's readiness read and
// quietly change what that spec asserts.
//
// TWO FILES, exactly as the repos seam has them and for the same reason:
//   * the CONTROL file (MOTIR_GITHUB_MERGE_CONTROL_PATH) — the spec WRITES, the mock READS,
//     re-read on every request, so a spec can refuse a press and then let the retry merge;
//   * the JOURNAL file (MOTIR_GITHUB_MERGE_JOURNAL_PATH) — the mock WRITES, the spec READS,
//     which is how a runner in another process proves the press reached THIS seam at all.
//
// ⚠️ The installation token the merge needs is minted by `lib/github/appAuth.ts`, which
// signs an App JWT first — so the lane must carry the App credentials for the role the
// repository's owner selects (`githubAppRoleForRepo`). That is the lane's wiring, not
// this seam's.

import { createHash } from 'node:crypto';
import { appendFixtureFileSync, readFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

const GITHUB_ORIGIN = 'https://api.github.com';

/** The typed refusals `mergeChangeRequest` classifies a host answer into. */
export type GithubMergeRefusal =
  | 'checks_not_green'
  | 'conflict'
  | 'out_of_date'
  | 'branch_protected'
  | 'already_merged'
  | 'app_permission_missing'
  | 'subject_changed';

/** What GitHub does with one pull request. */
export type GithubMergeAnswer =
  | { outcome: 'merged' }
  | { outcome: 'enqueued' }
  | { outcome: 'refused'; refusal: GithubMergeRefusal };

/** What the pull request READ reports about mergeability, independent of what the merge
 *  itself would do (MOTIR-5913). Unset, both are derived from the merge answer exactly
 *  as before — `dirty` only for a `conflict` refusal — so a spec that never names them
 *  sees the host it always did. */
export interface GithubMergeability {
  /** GitHub's `mergeable`: `null` is "not computed yet". */
  mergeable?: boolean | null;
  /** GitHub's `mergeable_state` (`clean`, `dirty`, …). */
  mergeableState?: string;
}

/** What the spec tells the fake GitHub to do. The empty control answers for no repository. */
export interface GithubMergeControl {
  /** `owner/name` of each repository this seam answers for. A pull request of a listed
   *  repository with no entry of its own MERGES. */
  repositories?: string[];
  /** `owner/name` of each listed repository whose base branch REQUIRES a merge queue, so
   *  every pull request in it is enqueued through the rules read. */
  mergeQueueRepositories?: string[];
  /** `owner/name#number` → GitHub's answer. `headSha` is the head the pull request read
   *  reports; omitted, the read reports no head and the merge's head check is skipped. */
  pullRequests?: Record<string, GithubMergeAnswer & { headSha?: string } & GithubMergeability>;
  /** REVIEWER LOGIN → the permission the host reports for them (Story MOTIR-4910 ·
   *  MOTIR-5595). Keys are case-insensitive, as every other key here is.
   *
   *  ⚠️ THE DEFAULT IS `write`, so an unconfigured reviewer COUNTS. The lane's ordinary
   *  case is a reviewer who may approve, and making the default `none` would mean every
   *  spec had to configure a permission before its approval did anything — a silent way
   *  for a spec to assert that nothing happened and be right for the wrong reason.
   *  A spec proving a drive-by reviewer decides nothing names them here explicitly.
   *
   *  `'404'` stands for the host's own answer for a user with no access at all, which the
   *  provider maps to `none`; `'403'` and `'500'` drive the `ProviderPermissionReadError`
   *  path a consumer records as `unknown`. */
  reviewerPermissions?: Record<string, GithubReviewerPermission>;
  /** `owner/name#number` → the files the pull request's HEAD writes (Story MOTIR-4907 ·
   *  MOTIR-5681). What the decision capture reads to find a `docs/decisions/*.md` file.
   *  Omitted, the list is empty — the merge webhook's paths capture, as before. */
  pullRequestFiles?: Record<string, { path: string; sha: string; status?: string }[]>;
  /** `owner/name:path` → the file's text, served RAW at any ref (MOTIR-5681) — what the
   *  decision port reads through the resolver. A path with no entry is GitHub's 404.
   *
   *  `owner/name@ref:path` → the text AT THAT REF ONLY (MOTIR-7866), tried first — the
   *  request's `ref` query parameter, decoded — so a spec can prove a read reached the
   *  host at the ref it asked for. A ref-blind key still answers every ref. */
  fileContents?: Record<string, string>;
  /** `owner/name@sha` → the check runs GitHub reports for that commit (Story MOTIR-6843 ·
   *  MOTIR-6851) — what the reconcile tick reads for a merge group whose `check_run`
   *  delivery never came. ⚠️ ONLY a commit named here is answered: a check-runs read for
   *  any other commit is not claimed, so the shared agent refuses it BY NAME
   *  (`lib/test-mock-agent.ts`) and the caller sees "no answer", exactly as it would for a
   *  host that could not be reached. */
  commitCheckRuns?: Record<string, GithubCommitCheckRun[]>;
}

/** One check run as the host reports it on a commit. `status` defaults to `completed`. */
export interface GithubCommitCheckRun {
  name: string;
  conclusion: string | null;
  status?: string;
}

/** What the fake host says about one reviewer. The six real permissions, plus the two
 *  status codes a spec needs to drive the not-an-answer paths. */
export type GithubReviewerPermission =
  | 'admin'
  | 'maintain'
  | 'write'
  | 'triage'
  | 'read'
  | 'none'
  | '404'
  | '403'
  | '500';

/** One outbound call the fake answered — the journal's line shape (JSONL). */
export interface GithubMergeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  /** `owner/name#number`, when the call is about one pull request. */
  pullRequest: string | null;
}

function readControl(): GithubMergeControl {
  const path = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH'];
  if (!path) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as GithubMergeControl;
  } catch {
    // No file yet, or a half-written one: this seam then answers for no repository.
    return {};
  }
}

/** JSONL, so a concurrent append can never truncate an earlier line. */
function journal(call: GithubMergeCall): void {
  const path = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH'];
  if (!path) return;
  try {
    appendFixtureFileSync(path, `${JSON.stringify(call)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

interface MockReply {
  statusCode: number;
  data: object | string;
  responseOptions: { headers: Record<string, string> };
}

interface MockRequest {
  path: string;
  body?: unknown;
}

const reply = (
  statusCode: number,
  data: object | string,
  headers: Record<string, string> = {},
): MockReply => ({
  statusCode,
  data,
  responseOptions: { headers: { 'content-type': 'application/json', ...headers } },
});

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Does this seam answer for `owner/name`? */
function answersFor(control: GithubMergeControl, repository: string): boolean {
  return (
    (control.repositories ?? []).some((r) => same(r, repository)) ||
    Object.keys(control.pullRequests ?? {}).some((key) =>
      same(key.slice(0, key.lastIndexOf('#')), repository),
    )
  );
}

/** The answer for one pull request: its own entry, else a merge. */
function answerFor(
  control: GithubMergeControl,
  key: string,
): GithubMergeAnswer & { headSha?: string } & GithubMergeability {
  const entry = Object.entries(control.pullRequests ?? {}).find(([k]) => same(k, key));
  return entry?.[1] ?? { outcome: 'merged' };
}

const REPO_PATH = /^\/repos\/([^/]+)\/([^/?]+)$/;
const PULL_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/;
const MERGE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/;
const RULES_PATH = /^\/repos\/([^/]+)\/([^/]+)\/rules\/branches\/[^?]+$/;
const FILES_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files(?:\?.*)?$/;
const CONTENTS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)(?:\?.*)?$/;
const COMMIT_REF_PATH = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/?]+)(?:\?.*)?$/;
const CHECK_RUNS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-fA-F]+)\/check-runs(?:\?.*)?$/;
const PERMISSION_PATH = /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/?]+)\/permission(?:\?.*)?$/;

/** A permission path's repository and username, when this seam answers for that repository. */
function scopedPermission(path: string): { repository: string; username: string } | null {
  const m = PERMISSION_PATH.exec(path);
  if (!m) return null;
  const repository = `${m[1]}/${m[2]}`;
  if (!answersFor(readControl(), repository)) return null;
  return { repository, username: decodeURIComponent(m[3]!) };
}

/** A path's repository and pull request, when this seam answers for that repository. */
/** The fake commit the seam answers for `ref` in `repository` — stable, so a spec can
 *  compute the commit a read was made at (MOTIR-10122). */
export function e2eRefSha(repository: string, ref: string): string {
  return createHash('sha1').update(`${repository.toLowerCase()}@${ref}`).digest('hex');
}

/** Every fake commit handed out, back to the ref it stands for. */
const refOfSha = new Map<string, string>();

function scoped(pattern: RegExp, path: string): { repository: string; key: string | null } | null {
  const m = pattern.exec(path);
  if (!m) return null;
  const repository = `${m[1]}/${m[2]}`;
  if (!answersFor(readControl(), repository)) return null;
  return { repository, key: m[3] ? `${repository}#${m[3]}` : null };
}

/** The check runs the control names for a check-runs path's commit, or null when it names
 *  none — in which case the path is not this seam's to answer. */
function scopedCheckRuns(path: string): { commit: string; runs: GithubCommitCheckRun[] } | null {
  const m = CHECK_RUNS_PATH.exec(path);
  if (!m) return null;
  const commit = `${m[1]}/${m[2]}@${m[3]}`;
  const runs = Object.entries(readControl().commitCheckRuns ?? {}).find(([k]) =>
    same(k, commit),
  )?.[1];
  return runs ? { commit, runs } : null;
}

/** The permission this seam reports for `username`, defaulting to `write`. */
export function reviewerPermissionFor(
  control: GithubMergeControl,
  username: string,
): GithubReviewerPermission {
  const entry = Object.entries(control.reviewerPermissions ?? {}).find(([login]) =>
    same(login, username),
  );
  return entry?.[1] ?? 'write';
}

const NODE_ID_PREFIX = 'E2E_MERGE_PR_';

/** The GraphQL node id this seam hands out for a pull request, and reads back on an enqueue. */
export function mergeMockNodeId(key: string): string {
  return `${NODE_ID_PREFIX}${Buffer.from(key, 'utf8').toString('base64url')}`;
}

function keyOfNodeId(body: string): string | null {
  const m = new RegExp(`${NODE_ID_PREFIX}([A-Za-z0-9_-]+)`).exec(body);
  return m ? Buffer.from(m[1]!, 'base64url').toString('utf8') : null;
}

/** The host's wording and the pull request's `mergeable_state` for each 405 refusal — the two
 *  facts `mergeChangeRequest` classifies a refused merge by. */
const REFUSED_MERGE: Record<
  'checks_not_green' | 'conflict' | 'out_of_date' | 'branch_protected',
  { message: string; mergeableState: string }
> = {
  checks_not_green: {
    message: 'Required status check "ci" is expected.',
    mergeableState: 'blocked',
  },
  conflict: { message: 'Pull Request is not mergeable', mergeableState: 'dirty' },
  // A base whose required checks are STRICT, with the head behind it: GitHub's message
  // names the required checks although they are green (MOTIR-10054, motir-infra#11).
  out_of_date: {
    message: '2 of 2 required status checks are expected.',
    mergeableState: 'behind',
  },
  branch_protected: {
    message: 'At least 1 approving review is required by reviewers with write access.',
    mergeableState: 'blocked',
  },
};

function mergeableStateOf(answer: GithubMergeAnswer & GithubMergeability): string {
  if (answer.mergeableState !== undefined) return answer.mergeableState;
  if (answer.outcome !== 'refused') return 'clean';
  const refused = REFUSED_MERGE[answer.refusal as keyof typeof REFUSED_MERGE];
  return refused?.mergeableState ?? 'clean';
}

function parseBody(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One query parameter of a request path, decoded; `null` when absent. */
function queryParam(path: string, name: string): string | null {
  const q = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  return new URLSearchParams(q).get(name);
}

export function installGithubMergeMock(agent: MockAgent): void {
  const pool = agent.get(GITHUB_ORIGIN);

  // ── The repository read: the allowed merge methods ─────────────────────────
  pool
    .intercept({ path: (p) => scoped(REPO_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const { repository } = scoped(REPO_PATH, path)!;
      journal({ method: 'GET', path, body: null, pullRequest: null });
      return reply(200, { full_name: repository, allow_squash_merge: true });
    })
    .persist();

  // ── The pull request, as it stands (the first read and the re-read after a 405) ──
  pool
    .intercept({ path: (p) => scoped(PULL_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const { key } = scoped(PULL_PATH, path)!;
      journal({ method: 'GET', path, body: null, pullRequest: key });
      const answer = answerFor(readControl(), key!);
      const refusal = answer.outcome === 'refused' ? answer.refusal : null;
      return reply(200, {
        node_id: mergeMockNodeId(key!),
        number: Number(key!.slice(key!.lastIndexOf('#') + 1)),
        merged: refusal === 'already_merged',
        state: refusal === 'already_merged' || refusal === 'subject_changed' ? 'closed' : 'open',
        head: answer.headSha ? { sha: answer.headSha } : {},
        base: { ref: 'main' },
        mergeable_state: mergeableStateOf(answer),
        mergeable:
          answer.mergeable !== undefined ? answer.mergeable : mergeableStateOf(answer) !== 'dirty',
      });
    })
    .persist();

  // ── Does the base branch require a merge queue? ────────────────────────────
  pool
    .intercept({ path: (p) => scoped(RULES_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const { repository } = scoped(RULES_PATH, path)!;
      journal({ method: 'GET', path, body: null, pullRequest: null });
      const queued = (readControl().mergeQueueRepositories ?? []).some((r) => same(r, repository));
      return reply(200, queued ? [{ type: 'merge_queue', parameters: {} }] : []);
    })
    .persist();

  // ── The merge ──────────────────────────────────────────────────────────────
  pool
    .intercept({ path: (p) => scoped(MERGE_PATH, p) !== null, method: 'PUT' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const { key } = scoped(MERGE_PATH, path)!;
      journal({ method: 'PUT', path, body: parseBody(req.body), pullRequest: key });
      const answer = answerFor(readControl(), key!);
      const number = key!.slice(key!.lastIndexOf('#') + 1);

      if (answer.outcome === 'merged') {
        return reply(200, { merged: true, sha: `e2e-merge-${number}`, message: 'Merged' });
      }
      // A branch that must be merged through its queue refuses the direct merge with this
      // wording, which routes `mergeChangeRequest` to the enqueue.
      if (answer.outcome === 'enqueued') {
        return reply(405, { message: 'Changes must be made through the merge queue' });
      }
      switch (answer.refusal) {
        case 'app_permission_missing':
          return reply(
            403,
            { message: 'Resource not accessible by integration' },
            { 'x-accepted-github-permissions': 'contents=write' },
          );
        case 'subject_changed':
          return reply(409, {
            message: 'Head branch was modified. Review and try the merge again.',
          });
        case 'already_merged':
          return reply(405, { message: 'Pull Request is not mergeable' });
        default:
          return reply(405, { message: REFUSED_MERGE[answer.refusal].message });
      }
    })
    .persist();

  // ── The merged pull request's changed files ────────────────────────────────
  // The merge WEBHOOK the spec drives afterwards captures a merged pull request's changed
  // paths (`githubWebhookService`, best-effort). Answered here so that capture reads an
  // empty list rather than leaving for the real host with a synthetic token.
  pool
    .intercept({ path: (p) => scoped(FILES_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const { key } = scoped(FILES_PATH, path)!;
      journal({ method: 'GET', path, body: null, pullRequest: key });
      // The HEAD's files, when the spec names them (MOTIR-5681) — each row with the
      // `contents_url` whose `ref` is the head, which is how the capture learns it.
      const control = readControl();
      const files =
        Object.entries(control.pullRequestFiles ?? {}).find(([k]) => same(k, key!))?.[1] ?? [];
      const head = answerFor(control, key!).headSha ?? 'e2e-head';
      const { repository } = scoped(FILES_PATH, path)!;
      return reply(
        200,
        files.map((file) => ({
          filename: file.path,
          sha: file.sha,
          status: file.status ?? 'added',
          contents_url: `${GITHUB_ORIGIN}/repos/${repository}/contents/${file.path}?ref=${head}`,
        })),
      );
    })
    .persist();

  // ── The commit a ref names (MOTIR-10122) ──────────────────────────────────
  // `read_file` resolves its ref to a commit and reads AT it. The seam answers a stable
  // fake commit per (repository, ref) — `e2eRefSha` — and remembers the pair, so the
  // contents read below still finds the text a control keyed by the ref's NAME.
  pool
    .intercept({ path: (p) => scoped(COMMIT_REF_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const m = COMMIT_REF_PATH.exec(path)!;
      const repository = `${m[1]}/${m[2]}`;
      const ref = decodeURIComponent(m[3]!);
      journal({ method: 'GET', path, body: null, pullRequest: null });
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : e2eRefSha(repository, ref);
      refOfSha.set(sha, ref);
      return reply(200, sha, { 'content-type': 'text/plain; charset=utf-8' });
    })
    .persist();

  // ── A file's contents at a ref, RAW (Story MOTIR-4907 · MOTIR-5681) ─────────
  // The decision port reads the document through `readFileAtRef`, which asks for the raw
  // media type. Scoped like every intercept here; a path the control does not name is the
  // host's own 404 for a missing path.
  pool
    .intercept({ path: (p) => scoped(CONTENTS_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const m = CONTENTS_PATH.exec(path)!;
      const repository = `${m[1]}/${m[2]}`;
      const filePath = decodeURIComponent(m[3]!);
      const asked = queryParam(path, 'ref');
      // A read at a commit the seam handed out reads at the ref that commit stands for.
      const ref = asked !== null ? (refOfSha.get(asked) ?? asked) : null;
      journal({ method: 'GET', path, body: null, pullRequest: null });
      // The REF-qualified key first (`owner/name@ref:path`, MOTIR-7866), so one path can
      // read differently at two refs; then the ref-blind `owner/name:path` key every
      // earlier spec writes, which still answers at any ref.
      const contents = Object.entries(readControl().fileContents ?? {});
      const lookup = (key: string) => contents.find(([k]) => same(k, key))?.[1];
      const text =
        (ref !== null ? lookup(`${repository}@${ref}:${filePath}`) : undefined) ??
        lookup(`${repository}:${filePath}`);
      return text === undefined
        ? reply(404, { message: 'Not Found' })
        : reply(200, text, { 'content-type': 'text/plain; charset=utf-8' });
    })
    .persist();

  // ── The enqueue, for a pull request whose node id this seam handed out ─────
  pool
    .intercept({
      path: '/graphql',
      method: 'POST',
      body: (body) => typeof body === 'string' && body.includes(NODE_ID_PREFIX),
    })
    .reply((req: MockRequest): MockReply => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const key = keyOfNodeId(raw);
      journal({ method: 'POST', path: '/graphql', body: parseBody(raw), pullRequest: key });
      const number = key ? key.slice(key.lastIndexOf('#') + 1) : '0';
      return reply(200, {
        data: { enqueuePullRequest: { mergeQueueEntry: { id: `MQE_e2e_${number}` } } },
      });
    })
    .persist();

  // ── A commit's check runs (Story MOTIR-6843 · MOTIR-6851) ──────────────────
  // The reconcile tick reads a merge group's check runs when the group's `check_run`
  // delivery never arrived. Answered ONLY for a commit the control names; every other
  // commit falls through to the shared agent's refusal.
  pool
    .intercept({ path: (p) => scopedCheckRuns(p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const { commit, runs } = scopedCheckRuns(path)!;
      journal({ method: 'GET', path, body: null, pullRequest: null });
      const repository = commit.slice(0, commit.lastIndexOf('@'));
      return reply(200, {
        total_count: runs.length,
        check_runs: runs.map((run, i) => {
          const status = run.status ?? 'completed';
          return {
            name: run.name,
            status,
            conclusion: status === 'completed' ? run.conclusion : null,
            check_suite: { id: 6851 },
            html_url: `https://github.com/${repository}/actions/runs/6851/job/${i + 1}`,
            completed_at: status === 'completed' ? new Date().toISOString() : null,
          };
        }),
      });
    })
    .persist();

  // ── A reviewer's permission on the repository (MOTIR-5595) ────────────────
  // `getRepositoryPermission` reads this to decide whether a review COUNTS. Scoped to
  // the repositories the control names, exactly as every intercept above is.
  pool
    .intercept({
      path: (p) => PERMISSION_PATH.test(p) && scopedPermission(p) !== null,
      method: 'GET',
    })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const username = scopedPermission(path)!.username;
      journal({ method: 'GET', path, body: null, pullRequest: null });
      const permission = reviewerPermissionFor(readControl(), username);

      // The host's own answer for a user with no access — the provider maps it to
      // `none`, so a spec driving it proves the MAPPING rather than a stub of it.
      if (permission === '404') return reply(404, { message: 'Not Found' });
      if (permission === '403') {
        return reply(403, { message: 'Resource not accessible by integration' });
      }
      if (permission === '500') return reply(500, { message: 'Server Error' });

      return reply(200, {
        permission: permission === 'maintain' || permission === 'triage' ? 'read' : permission,
        role_name: permission,
        user: { login: username },
      });
    })
    .persist();

  // ── The installation token — unless the repos seam already answers it ──────
  // Both seams on at once is the acceptance lane's normal state, and that seam journals
  // the mint for its own spec; answering it here first would take the line out of its
  // journal.
  if (process.env['E2E_TEST_GITHUB_REPOS'] !== '1') {
    pool
      .intercept({
        path: (p) => /^\/app\/installations\/[^/]+\/access_tokens$/.test(p),
        method: 'POST',
      })
      .reply((req: MockRequest): MockReply => {
        journal({ method: 'POST', path: String(req.path), body: null, pullRequest: null });
        return reply(201, {
          token: 'ghs_e2e_merge_token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      })
      .persist();
  }
}
